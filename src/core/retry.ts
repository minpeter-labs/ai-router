import {
  boundedErrorText,
  boundedProviderErrorText,
  safeErrorProperty,
} from "./error-text";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";
import type { ShouldRetryThisError } from "./types";

export type { ShouldRetryThisError } from "./types";

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
const RETRYABLE_STATUS = new Set([
  // In a multi-provider route these statuses are commonly scoped to one
  // provider's endpoint, credentials, parameter dialect, or model catalogue.
  // A caller that knows a 4xx is universal can retain strict behaviour with a
  // custom `shouldRetry` classifier.
  400, 401, 402, 403, 408, 409, 412, 413, 421, 422, 425, 429, 498,
]);

const MODEL_UNAVAILABLE_RE =
  /\bunknown model\b|\bmodel\b[\s\S]{0,160}\b(?:not found|not available|does not exist|not supported by any provider)\b|\bno (?:available )?endpoints? (?:(?:was|were) )?found\b|\brequested provider\b[\s\S]{0,160}\bnot available\b|\bunable to access model\b[\s\S]{0,160}\bsupported models?\b|\bupstream_waf_blocked\b|\bcloudflare waf\b[\s\S]{0,40}\b(?:block(?:ed)?|reject(?:ed|ion)?|den(?:y|ied))\b/i;
const MODEL_UNAVAILABLE_CODE_RE = /\bmodel_(?:not_found|not_available)\b/i;
const MODEL_UNAVAILABLE_DETAIL_CODE_RE =
  /\b(?:code|type|tag)\b[\s\S]{0,40}\bmodel_(?:not_found|not_available)\b/i;
const CREDIT_EXHAUSTED_RE =
  /\b(?:insufficient|low|exhausted|exceeded|depleted|no more|not enough|requires available|run out|out of)\b[\s\S]{0,100}\b(?:balance|credits?|funds|quota)\b|\b(?:balance|credits?|funds|quota)\b[\s\S]{0,100}\b(?:insufficient|low|exhausted|exceeded|depleted|no more|not enough|run out|out of)\b/i;
const PROVIDER_CREDENTIAL_CODE_RE =
  /\b(?:access_terminated_error|invalid_api_key|authentication_error|invalid_authentication|invalid_token|api_key_(?:invalid|disabled)|key_disabled|rate_limit_error|insufficient_quota|quota_exceeded|no_more_credits)\b/i;
const PROVIDER_CREDENTIAL_DETAIL_CODE_RE =
  /\b(?:code|type|tag)\b[\s\S]{0,40}\b(?:access_terminated_error|invalid_api_key|authentication_error|invalid_authentication|invalid_token|api_key_(?:invalid|disabled)|key_disabled|rate_limit_error|insufficient_quota|quota_exceeded|no_more_credits)\b/i;
const FAILURE_MESSAGES = new WeakMap<unknown[], string>();
const MAX_FAILURES = 10_000;
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

export function isProviderCredentialCode(value: unknown): boolean {
  return typeof value === "string" && PROVIDER_CREDENTIAL_CODE_RE.test(value);
}

export function isModelUnavailableCode(value: unknown): boolean {
  return typeof value === "string" && MODEL_UNAVAILABLE_CODE_RE.test(value);
}

export function hasProviderCredentialCodeInDetails(value: string): boolean {
  return PROVIDER_CREDENTIAL_DETAIL_CODE_RE.test(value);
}

export function hasModelUnavailableCodeInDetails(value: string): boolean {
  return MODEL_UNAVAILABLE_DETAIL_CODE_RE.test(value);
}

export function hasRoutingUnitUnavailableDetails(value: string): boolean {
  return MODEL_UNAVAILABLE_RE.test(value);
}

function failureMessage(error: unknown): string {
  let rawMessage: unknown;
  if (isObjectLike(error)) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      rawMessage =
        descriptor !== undefined && "value" in descriptor
          ? descriptor.value
          : undefined;
    } catch {
      // Fall through to the bounded diagnostic-field snapshot.
    }
  }
  return typeof rawMessage === "string"
    ? boundedErrorText(rawMessage, 1024)
    : boundedErrorText(error, 1024) || "unknown error";
}

export function recordFailure(errors: unknown[], error: unknown): void {
  errors.push(error);
  FAILURE_MESSAGES.set(errors, failureMessage(error));
}

export function copyFailureRecord(source: unknown[], target: unknown[]): void {
  const message = FAILURE_MESSAGES.get(source);
  if (message !== undefined) {
    FAILURE_MESSAGES.set(target, message);
  }
}

function snapshotFailures(errors: unknown[]): unknown[] {
  let length = 0;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(errors, "length");
    const candidate =
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      return [];
    }
    length = Math.min(candidate, MAX_FAILURES);
  } catch {
    return [];
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index++) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(errors, index);
      snapshot[index] =
        descriptor !== undefined && "value" in descriptor
          ? descriptor.value
          : undefined;
    } catch {
      snapshot[index] = undefined;
    }
  }
  return snapshot;
}

function isObjectLike(value: unknown): value is object {
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

export function shouldRetryErrorSnapshot(
  snapshot: RetryErrorSnapshot
): boolean {
  if (snapshot.aborted) {
    return false;
  }
  const { code, details, statusCode } = snapshot;
  if (
    isProviderCredentialCode(code) ||
    hasProviderCredentialCodeInDetails(details)
  ) {
    return true;
  }
  if (
    isModelUnavailableCode(code) ||
    hasModelUnavailableCodeInDetails(details)
  ) {
    return true;
  }
  if (snapshot.invalidCode === true && statusCode === undefined) {
    return false;
  }
  if (snapshot.invalidStatus === true && statusCode === undefined) {
    return false;
  }
  if (statusCode !== undefined) {
    if (RETRYABLE_STATUS.has(statusCode) || statusCode >= 500) {
      return true;
    }
    if (
      statusCode === 404 &&
      (hasRoutingUnitUnavailableDetails(details) ||
        CREDIT_EXHAUSTED_RE.test(details))
    ) {
      return true;
    }
    if (statusCode >= 400 && statusCode < 500) {
      return false;
    }
  }
  return true;
}

/**
 * Reduce an unknown error to the two things the classifier reasons about: a
 * numeric `statusCode` (when present) and a lowercased `message` to pattern-match.
 *
 * The `error` field of a v4 stream error part is typed `unknown` and the
 * openai-compatible provider may deliver an `Error`, a plain string, or an
 * arbitrary object — so this must cope with all of them.
 */
export function normalizeError(error: unknown): {
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
export function defaultShouldRetryThisError(error: unknown): boolean {
  return shouldRetryErrorSnapshot(snapshotRetryError(error));
}

/** Resolve the classifier to use: the caller's hook, or the default. */
export function resolveShouldRetry(
  hook?: ShouldRetryThisError
): ShouldRetryThisError {
  return hook ?? defaultShouldRetryThisError;
}

/** Run a classifier defensively — a throw inside it degrades to "do not retry". */
export function safeShouldRetry(
  shouldRetry: ShouldRetryThisError,
  error: unknown
): boolean {
  try {
    const result: unknown = shouldRetry(error);
    if (consumeGenuinePromise(result)) {
      return false;
    }
    return result === true;
  } catch {
    return false;
  }
}

/**
 * Build the error to surface when every candidate has failed.
 *
 *  - 0 errors (defensive; unreachable in practice) -> a generic Error.
 *  - 1 error -> that error verbatim (identity preserved for the common case).
 *  - many -> an `AggregateError` whose `.errors` holds every candidate error and
 *    whose `.message` embeds the last error's message.
 */
export function surfaceFailure(errors: unknown[], logicalId: string): unknown {
  const failures = snapshotFailures(errors);
  if (failures.length === 0) {
    return new Error(`ai-router: all candidates for "${logicalId}" failed`);
  }
  if (failures.length === 1) {
    return failures[0];
  }
  const last = failures.at(-1);
  const lastMessage = FAILURE_MESSAGES.get(errors) ?? failureMessage(last);
  return new AggregateError(
    failures,
    `ai-router: all ${failures.length} candidates for "${logicalId}" failed; last error: ${lastMessage}`,
    { cause: last }
  );
}
