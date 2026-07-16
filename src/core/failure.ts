import { safeErrorProperty } from "./error-text";
import { retryAfterMsOfContext } from "./failure-retry-after";
import {
  hasModelUnavailableCodeInDetails,
  hasProviderCredentialCodeInDetails,
  hasProviderUnavailableCodeInDetails,
  hasRoutingUnitUnavailableDetails,
  isModelUnavailableCode,
  isProviderCredentialCode,
  isProviderUnavailableCode,
  shouldRetryErrorSnapshot,
} from "./retry";
import { snapshotRetryErrorContext } from "./retry-snapshot";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";
import type { FailureClassification, FailureScope } from "./types";

const PROVIDER_SCOPED = new Set([400, 404, 409, 413, 422]);
const CREDENTIAL_SCOPED = new Set([401, 402, 403, 412, 429, 498]);
const AUTH_DEAD_COOLDOWN_MS = 3_600_000;
const QUOTA_LIKE_RE =
  /\b(?:balance|credits?|funds|quota|budgets?|spend(?:ing)?|billing|monthly|rate.?limit|usage.?limit|suspend|resource package|recharge|top.?up)\b/i;
const EXHAUSTED_RE =
  /\b(?:insufficient|low|exhaust(?:ed|ion)?|exceed(?:ed|s|ing)?|deplet(?:e|ed|ion)?|over|run out|out of|no more|not enough|requires available)\b/i;
const MISSING_CREDENTIAL_RE =
  /\b(?:missing|no|unavailable)\b[\s\S]{0,40}\b(?:upstream\s+)?(?:credentials?|api[ -]?keys?)\b|\b(?:upstream\s+)?(?:credentials?|api[ -]?keys?)\b[\s\S]{0,40}\b(?:missing|not configured|unavailable)\b/i;
const PLAN_ACCESS_RE =
  /\b(?:(?:subscription|current|paid) plan|pay-as-you-go)\b/i;
const HARD_AUTH_CODE_RE =
  /\b(?:access_terminated_error|invalid_api_key|authentication_error|invalid_authentication|invalid_token|api_key_(?:invalid|disabled)|key_disabled)\b/i;
const HARD_AUTH_DETAIL_CODE_RE =
  /\b(?:code|type|tag)\b[\s\S]{0,40}\b(?:access_terminated_error|invalid_api_key|authentication_error|invalid_authentication|invalid_token|api_key_(?:invalid|disabled)|key_disabled)\b/i;
const REQUEST_ERROR_CODES = new Set([
  "call_options_contract_error",
  "cancellation_unavailable",
  "caller_abort",
  "timer_unavailable",
  "total_timeout",
  "stream_unavailable",
  "validator_contract_error",
]);
const FAILURE_SCOPES = new Set<FailureScope>([
  "request",
  "credential",
  "routing-unit",
  "provider-family",
  "transient",
]);

export function normalizeFailureClassification(
  value: unknown
): FailureClassification {
  if (typeof value !== "object" || value === null) {
    throw new Error("invalid failure classification");
  }
  if (consumeGenuinePromise(value)) {
    throw new Error("failure classification must be synchronous");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "cooldownMs",
    "retryAfterMs",
    "retryable",
    "scope",
    "statusCode",
  ] as const;
  consumeOwnDataPromiseFields(record, keys);
  const field = (key: (typeof keys)[number]) => {
    const candidate = record[key];
    if (consumeGenuinePromise(candidate)) {
      throw new Error("failure classification must be synchronous");
    }
    return candidate;
  };
  const retryable = field("retryable");
  const scope = field("scope");
  if (
    typeof retryable !== "boolean" ||
    typeof scope !== "string" ||
    !FAILURE_SCOPES.has(scope as FailureScope)
  ) {
    throw new Error("invalid failure classification");
  }
  const optionalNumber = (key: string, nonNegative = false) => {
    const candidate = field(key as (typeof keys)[number]);
    if (candidate === undefined) {
      return;
    }
    if (
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      (nonNegative && candidate < 0)
    ) {
      throw new Error("invalid failure classification");
    }
    return candidate;
  };
  const cooldownMs = optionalNumber("cooldownMs", true);
  const retryAfterMs = optionalNumber("retryAfterMs", true);
  const statusCode = optionalNumber("statusCode");
  if (
    statusCode !== undefined &&
    (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)
  ) {
    throw new Error("invalid failure classification");
  }
  return {
    retryable,
    scope: scope as FailureScope,
    ...(cooldownMs === undefined ? {} : { cooldownMs }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

export function isTerminalRequestFailure(error: unknown): boolean {
  const code = safeErrorProperty(error, "code");
  if (consumeGenuinePromise(code)) {
    return false;
  }
  return typeof code === "string" && REQUEST_ERROR_CODES.has(code);
}

function isCredentialFailure(
  statusCode: number,
  details: string,
  code: unknown
): boolean {
  if (hasCredentialCode(code, details)) {
    return true;
  }
  if (CREDENTIAL_SCOPED.has(statusCode)) {
    return true;
  }
  if (statusCode === 503 && MISSING_CREDENTIAL_RE.test(details)) {
    return true;
  }
  if (statusCode === 404 && PLAN_ACCESS_RE.test(details)) {
    return true;
  }
  return (
    (statusCode === 400 || statusCode === 404) &&
    QUOTA_LIKE_RE.test(details) &&
    EXHAUSTED_RE.test(details)
  );
}

function hasCredentialCode(code: unknown, details: string): boolean {
  return (
    isProviderCredentialCode(code) ||
    hasProviderCredentialCodeInDetails(details)
  );
}

function isHardAuthFailure(
  statusCode: number | undefined,
  details: string,
  code: unknown
): boolean {
  return (
    statusCode === 401 ||
    statusCode === 498 ||
    (typeof code === "string" && HARD_AUTH_CODE_RE.test(code)) ||
    HARD_AUTH_DETAIL_CODE_RE.test(details) ||
    (statusCode === 403 &&
      !QUOTA_LIKE_RE.test(details) &&
      !hasRoutingUnitUnavailableEvidence(code, details)) ||
    (statusCode === 503 && MISSING_CREDENTIAL_RE.test(details))
  );
}

function hasRoutingUnitUnavailableCodeEvidence(
  code: unknown,
  details: string
): boolean {
  return (
    isModelUnavailableCode(code) ||
    hasModelUnavailableCodeInDetails(details) ||
    isProviderUnavailableCode(code) ||
    hasProviderUnavailableCodeInDetails(details)
  );
}

function hasRoutingUnitUnavailableEvidence(
  code: unknown,
  details: string
): boolean {
  return (
    hasRoutingUnitUnavailableCodeEvidence(code, details) ||
    hasRoutingUnitUnavailableDetails(details)
  );
}

function defaultFailureScope(
  statusCode: number | undefined,
  retryable: boolean,
  details: string,
  code: unknown
): FailureScope {
  if (hasCredentialCode(code, details)) {
    return "credential";
  }
  if (hasRoutingUnitUnavailableCodeEvidence(code, details)) {
    return "routing-unit";
  }
  if (PLAN_ACCESS_RE.test(details)) {
    return "credential";
  }
  if (hasRoutingUnitUnavailableDetails(details)) {
    return "routing-unit";
  }
  if (statusCode === undefined) {
    return retryable ? "transient" : "request";
  }
  if (!retryable && statusCode >= 400 && statusCode < 500) {
    return "request";
  }
  if (isCredentialFailure(statusCode, details, code)) {
    return "credential";
  }
  if (PROVIDER_SCOPED.has(statusCode)) {
    return "routing-unit";
  }
  return "transient";
}

export function defaultClassifyFailure(error: unknown): FailureClassification {
  const { cause, causeResponse, response, snapshot } =
    snapshotRetryErrorContext(error, "always", true);
  const { code, details, statusCode } = snapshot;
  const retryable = shouldRetryErrorSnapshot(snapshot);

  if (typeof code === "string" && REQUEST_ERROR_CODES.has(code)) {
    return { retryable: false, scope: "request" };
  }
  if (code === "invalid_provider_model") {
    return {
      cooldownMs: AUTH_DEAD_COOLDOWN_MS,
      retryable: true,
      scope: "routing-unit",
    };
  }
  const scope = defaultFailureScope(statusCode, retryable, details, code);
  const retryAfterMs = retryAfterMsOfContext(error, undefined, {
    cause,
    causeResponse,
    response,
  });
  const hardAuthFailure = isHardAuthFailure(statusCode, details, code);
  return {
    retryable,
    scope,
    ...(hardAuthFailure ? { cooldownMs: AUTH_DEAD_COOLDOWN_MS } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}
