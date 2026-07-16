import { boundedErrorText } from "./error-text";
import {
  isObjectLike,
  normalizeRetryError,
  type RetryErrorSnapshot,
  snapshotRetryError,
} from "./retry-snapshot";
import { consumeGenuinePromise } from "./runtime-types";
import type { ShouldRetryThisError } from "./types";

export type { ShouldRetryThisError } from "./types";

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
  return normalizeRetryError(error);
}

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
