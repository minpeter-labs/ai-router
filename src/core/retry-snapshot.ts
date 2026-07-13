import {
  boundedErrorText,
  boundedProviderErrorText,
  safeErrorProperty,
} from "./error-text";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";

const RETRY_ERROR_DATA_KEYS = [
  "body",
  "cause",
  "code",
  "data",
  "message",
  "name",
  "response",
  "responseBody",
  "status",
  "statusCode",
] as const;

function consumeRetryErrorDataFields(value: unknown): void {
  if (isObjectLike(value)) {
    consumeOwnDataPromiseFields(value, RETRY_ERROR_DATA_KEYS);
  }
}

function normalizedErrorMessage(
  error: unknown,
  rawMessage: unknown,
  causeMessage: unknown
): string {
  if (typeof rawMessage === "string" && rawMessage.length > 0) {
    return boundedErrorText(rawMessage).toLowerCase();
  }
  if (typeof causeMessage === "string" && causeMessage.length > 0) {
    return boundedErrorText(causeMessage).toLowerCase();
  }
  return boundedErrorText(error).toLowerCase();
}

function normalizeObjectError(error: object): {
  statusCode?: number;
  message: string;
} {
  consumeRetryErrorDataFields(error);
  const rawMessage = safeErrorProperty(error, "message");
  const responseValue = safeErrorProperty(error, "response");
  const response = synchronousRetryContainer(responseValue);
  const topStatusCode = statusCodeOf(error, response);
  const hasTopMessage = typeof rawMessage === "string" && rawMessage.length > 0;
  const causeValue =
    topStatusCode === undefined || !hasTopMessage
      ? safeErrorProperty(error, "cause")
      : undefined;
  const asyncCause = consumeGenuinePromise(causeValue);
  const cause = causeValue === error || asyncCause ? undefined : causeValue;
  const causeResponse =
    topStatusCode === undefined
      ? synchronousRetryContainer(safeErrorProperty(cause, "response"))
      : undefined;
  const statusCode = topStatusCode ?? statusCodeOf(cause, causeResponse);
  const causeMessage = hasTopMessage
    ? undefined
    : safeErrorProperty(cause, "message");
  const message = normalizedErrorMessage(error, rawMessage, causeMessage);
  return statusCode == null ? { message } : { statusCode, message };
}

/**
 * Status codes that are positively RETRYABLE (transient/capacity/auth-refresh
 * conditions where another provider may succeed). Mirrors `ai-fallback`.
 * In addition, any status `>= 500` is retryable.
 */

const nativeErrorIsError = (
  Error as unknown as { isError?: (value: unknown) => boolean }
).isError;
const nativeDOMExceptionNameGetter = (() => {
  try {
    return Object.getOwnPropertyDescriptor(
      globalThis.DOMException.prototype,
      "name"
    )?.get;
  } catch {
    return;
  }
})();

export function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function safeIsAbortError(error: unknown): boolean {
  try {
    const brandedError =
      typeof nativeErrorIsError === "function" && nativeErrorIsError(error);
    let brandedDOMException = false;
    if (typeof nativeDOMExceptionNameGetter === "function") {
      try {
        nativeDOMExceptionNameGetter.call(error);
        brandedDOMException = true;
      } catch {
        // Web-IDL accessors reject objects without DOMException internal slots.
      }
    }
    if (!(brandedError || error instanceof Error || brandedDOMException)) {
      return false;
    }
    const name = safeErrorProperty(error, "name");
    if (consumeGenuinePromise(name)) {
      return false;
    }
    return (
      name === "AbortError" ||
      name === "ResponseAborted" ||
      name === "TimeoutError"
    );
  } catch {
    return false;
  }
}

/** Only accept a finite number — never coerce a numeric string (e.g. 'ECONNRESET'). */
function pickNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

/**
 * Extract just the numeric HTTP status the classifier needs — without the
 * `message` normalization (and its `JSON.stringify`) that the default
 * classifier never reads.
 */
function errorDetailsOf(error: unknown, response: unknown): string {
  if (!isObjectLike(error)) {
    return String(error ?? "");
  }
  const message = safeErrorProperty(error, "message");
  const bodyDetails = [
    safeErrorProperty(error, "responseBody"),
    response,
    safeErrorProperty(error, "body"),
    safeErrorProperty(error, "data"),
  ]
    .filter((value) => value !== undefined)
    .map((value) => boundedProviderErrorText(value, 4096));
  return [boundedErrorText(message, 4096), ...bodyDetails].join(" ");
}

export interface RetryErrorSnapshot {
  aborted: boolean;
  code: unknown;
  details: string;
  invalidCode?: boolean;
  invalidStatus?: boolean;
  statusCode?: number;
}

export interface RetryErrorContext {
  cause: unknown;
  causeResponse: unknown;
  response: unknown;
  snapshot: RetryErrorSnapshot;
}

function statusCodeOf(value: unknown, response: unknown): number | undefined {
  return statusSnapshotOf(value, response).statusCode;
}

function captureErrorProperty(
  value: unknown,
  key: string
): { unreadable: boolean; value?: unknown } {
  if (!isObjectLike(value)) {
    return { unreadable: false };
  }
  try {
    const captured = Reflect.get(value as object, key);
    if (consumeGenuinePromise(captured)) {
      return { unreadable: true };
    }
    return { unreadable: false, value: captured };
  } catch {
    return { unreadable: true };
  }
}

function statusSnapshotOf(
  value: unknown,
  response: unknown
): { invalid: boolean; statusCode?: number } {
  if (!isObjectLike(value)) {
    return { invalid: false };
  }
  let invalid = false;
  const candidates: readonly (readonly [unknown, string])[] = [
    [value, "statusCode"],
    [value, "status"],
    [response, "statusCode"],
    [response, "status"],
  ];
  for (const [container, key] of candidates) {
    const captured = captureErrorProperty(container, key);
    if (captured.unreadable) {
      invalid = true;
      continue;
    }
    const candidate = captured.value;
    if (candidate === undefined) {
      continue;
    }
    const statusCode = pickNumber(candidate);
    if (statusCode !== undefined) {
      return { invalid, statusCode };
    }
    invalid = true;
  }
  return { invalid };
}

function shouldCaptureDetails(
  mode: "always" | "for-404",
  statusCode: number | undefined,
  invalidCode: boolean,
  invalidStatus: boolean
): boolean {
  return (
    mode === "always" || statusCode === 404 || invalidCode || invalidStatus
  );
}

function synchronousRetryContainer(value: unknown): unknown {
  return consumeGenuinePromise(value) ? undefined : value;
}

function boundedRetryCause(
  error: unknown,
  cause: unknown
): { async: boolean; value: unknown } {
  const async = consumeGenuinePromise(cause);
  return { async, value: cause === error || async ? undefined : cause };
}

export function snapshotRetryErrorContext(
  error: unknown,
  detailsMode: "always" | "for-404" = "for-404",
  captureCause = false
): RetryErrorContext {
  consumeRetryErrorDataFields(error);
  const objectLike = isObjectLike(error);
  const responseCapture = captureErrorProperty(error, "response");
  const asyncResponse = consumeGenuinePromise(responseCapture.value);
  const response = asyncResponse ? undefined : responseCapture.value;
  const topStatus = statusSnapshotOf(error, response);
  const topStatusCode = topStatus.statusCode;
  const causeCapture =
    objectLike && (captureCause || topStatusCode === undefined)
      ? captureErrorProperty(error, "cause")
      : { unreadable: false };
  const cause = causeCapture.value;
  const bounded = boundedRetryCause(error, cause);
  const asyncCause = bounded.async;
  const boundedCause = bounded.value;
  const causeResponseCapture = captureErrorProperty(boundedCause, "response");
  const asyncCauseResponse = consumeGenuinePromise(causeResponseCapture.value);
  const causeResponse = asyncCauseResponse
    ? undefined
    : causeResponseCapture.value;
  const causeStatus = statusSnapshotOf(boundedCause, causeResponse);
  const statusCode = topStatusCode ?? causeStatus.statusCode;
  const malformedStatus = [
    topStatus.invalid,
    causeStatus.invalid,
    responseCapture.unreadable,
    causeCapture.unreadable,
    causeResponseCapture.unreadable,
    asyncResponse,
    asyncCauseResponse,
    asyncCause,
  ].some(Boolean);
  const invalidStatus = statusCode === undefined && malformedStatus;
  const codeCapture = captureErrorProperty(error, "code");
  const code = codeCapture.value;
  const causeCodeCapture =
    code === undefined && topStatusCode === undefined
      ? captureErrorProperty(boundedCause, "code")
      : { unreadable: false };
  const causeCode = causeCodeCapture.value;
  const malformedCode = [
    codeCapture.unreadable,
    causeCodeCapture.unreadable,
    asyncCause,
  ].some(Boolean);
  const invalidCode =
    code === undefined && causeCode === undefined && malformedCode;
  const includeDetails = shouldCaptureDetails(
    detailsMode,
    statusCode,
    invalidCode,
    invalidStatus
  );
  return {
    cause: boundedCause,
    causeResponse,
    response,
    snapshot: {
      aborted: safeIsAbortError(error) || safeIsAbortError(boundedCause),
      code: code ?? (topStatusCode === undefined ? causeCode : undefined),
      details: includeDetails
        ? `${errorDetailsOf(error, response)} ${
            topStatusCode === undefined
              ? errorDetailsOf(boundedCause, causeResponse)
              : ""
          }`
        : "",
      ...(invalidCode ? { invalidCode: true } : {}),
      ...(invalidStatus ? { invalidStatus: true } : {}),
      ...(statusCode === undefined ? {} : { statusCode }),
    },
  };
}

export function snapshotRetryError(
  error: unknown,
  detailsMode: "always" | "for-404" = "for-404"
): RetryErrorSnapshot {
  return snapshotRetryErrorContext(error, detailsMode).snapshot;
}

export function normalizeRetryError(error: unknown): {
  statusCode?: number;
  message: string;
} {
  if (error == null) {
    return { message: "" };
  }
  if (typeof error === "string") {
    return { message: boundedErrorText(error).toLowerCase() };
  }
  if (isObjectLike(error)) {
    return normalizeObjectError(error);
  }
  return { message: String(error).toLowerCase() };
}

/**
 * Default classifier. Returns `true` to retry (fall through to the next
 * candidate), `false` to stop and surface the error.
 *
 * Decision order, driven by the numeric `statusCode` when one is present:
 *  1. An abort/timeout (the caller's `abortSignal` fired, or a `TimeoutError`)
 *     -> stop. Retrying another candidate with the same aborted signal is
 *     pointless and would swallow the caller's intent.
 *  2. A positively-retryable status (`RETRYABLE_STATUS` or `>= 500`) -> retry.
 *  3. A 4xx client error NOT in the retryable set (e.g. 404/410) -> stop.
 *     These are errors that are unlikely to change across providers. Use a
 *     custom classifier when an application needs stricter 4xx handling.
 *  4. Otherwise -> retry. A generic thrown error with no recognizable status is
 *     treated as a transient/unknown failure. This reproduces the router's
 *     historical "retry on any thrown error" behavior.
 *
 * Note: classification is intentionally status-based. A client error surfaced
 * only as a message string (no `statusCode`) is treated as unknown -> retried.
 * Callers wanting message-based or stricter policies should pass a custom
 * {@link ShouldRetryThisError} (and may call this as a fallback).
 */
