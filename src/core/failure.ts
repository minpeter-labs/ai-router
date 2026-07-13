import { safeErrorProperty } from "./error-text";
import {
  hasModelUnavailableCodeInDetails,
  hasProviderCredentialCodeInDetails,
  hasRoutingUnitUnavailableDetails,
  isModelUnavailableCode,
  isProviderCredentialCode,
  shouldRetryErrorSnapshot,
  snapshotRetryErrorContext,
} from "./retry";
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
const RESET_VALUE_RE = /^(\d+(?:\.\d+)?(?:e[+-]?\d+)?)(ms|s)?$/i;
const RETRY_AFTER_SECONDS_RE = /^\d+(?:\.\d+)?$/;
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

function finiteDelay(value: number): number | undefined {
  if (value === Number.POSITIVE_INFINITY) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (!Number.isFinite(value) || value < 0) {
    return;
  }
  return Math.min(value, Number.MAX_SAFE_INTEGER);
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
      !hasRoutingUnitUnavailableDetails(details)) ||
    (statusCode === 503 && MISSING_CREDENTIAL_RE.test(details))
  );
}

function hasModelUnavailableCode(code: unknown, details: string): boolean {
  return (
    isModelUnavailableCode(code) || hasModelUnavailableCodeInDetails(details)
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
  if (hasModelUnavailableCode(code, details)) {
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

interface HeaderSource {
  get?: CallableFunction;
  value: unknown;
  values?: ReadonlyMap<string, readonly string[]>;
}

const MAX_HEADER_VALUES = 16;
const MAX_HEADER_VALUE_CHARS = 512;

function headerStrings(value: unknown): string[] {
  if (consumeGenuinePromise(value)) {
    return [];
  }
  if (typeof value === "string") {
    return [value.slice(0, MAX_HEADER_VALUE_CHARS)];
  }
  try {
    if (!Array.isArray(value)) {
      return [];
    }
  } catch {
    return [];
  }
  let length = 0;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    const candidate =
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      return [];
    }
    length = Math.min(candidate, MAX_HEADER_VALUES);
  } catch {
    return [];
  }
  const values: string[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !("value" in descriptor)) {
        continue;
      }
      const item = descriptor.value;
      if (consumeGenuinePromise(item)) {
        continue;
      }
      if (typeof item === "string") {
        values.push(item.slice(0, MAX_HEADER_VALUE_CHARS));
      }
    } catch {
      // Ignore hostile indexes while retaining other bounded values.
    }
  }
  return values;
}

function headerSources(
  error: unknown,
  response: unknown,
  seen: Set<unknown>
): HeaderSource[] {
  const values = [
    safeErrorProperty(error, "responseHeaders"),
    safeErrorProperty(error, "headers"),
    safeErrorProperty(response, "responseHeaders"),
    safeErrorProperty(response, "headers"),
  ];
  const sources: HeaderSource[] = [];
  for (const value of values) {
    if (consumeGenuinePromise(value)) {
      continue;
    }
    if (
      ((typeof value === "object" && value !== null) ||
        typeof value === "function") &&
      seen.has(value)
    ) {
      continue;
    }
    seen.add(value);
    const getValue = safeErrorProperty(value, "get");
    const get = consumeGenuinePromise(getValue) ? undefined : getValue;
    const values = snapshotPlainHeaders(value);
    sources.push(
      typeof get === "function" ? { get, value, values } : { value, values }
    );
  }
  return sources;
}

function snapshotPlainHeaders(
  value: unknown
): ReadonlyMap<string, readonly string[]> {
  const snapshot = new Map<string, readonly string[]>();
  if (typeof value !== "object" || value === null) {
    return snapshot;
  }
  for (const name of RATE_LIMIT_HEADER_NAMES) {
    const header = ownHeaderValue(value, name);
    const values = headerStrings(header);
    if (values.length > 0) {
      snapshot.set(name, values);
    }
  }
  snapshotCaseInsensitiveHeaders(value, snapshot);
  return snapshot;
}

function snapshotCaseInsensitiveHeaders(
  value: object,
  snapshot: Map<string, readonly string[]>
): void {
  for (const [normalized, aliases] of RATE_LIMIT_HEADER_ALIASES) {
    if (snapshot.has(normalized)) {
      continue;
    }
    for (const alias of aliases) {
      const values = headerStrings(ownHeaderValue(value, alias));
      if (values.length > 0) {
        snapshot.set(normalized, values);
        break;
      }
    }
  }
}

function ownHeaderValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return;
  }
}

function headerValues(
  sources: readonly HeaderSource[],
  name: string
): string[] {
  const values: string[] = [];
  for (const source of sources) {
    values.push(...headerValuesFrom(source, name));
  }
  return values;
}

function headerValuesFromGetter(source: HeaderSource, name: string): string[] {
  if (source.get === undefined) {
    return [];
  }
  try {
    const value = Reflect.apply(source.get, source.value, [name]);
    if (consumeGenuinePromise(value)) {
      return [];
    }
    return headerStrings(value);
  } catch {
    return [];
  }
}

function headerValuesFrom(
  source: HeaderSource,
  name: string
): readonly string[] {
  const getterValues = headerValuesFromGetter(source, name);
  if (getterValues.length > 0) {
    return getterValues;
  }
  return source.values?.get(name) ?? [];
}

const RATE_LIMIT_HEADER_NAMES = new Set([
  "retry-after-ms",
  "retry-after",
  "x-ratelimit-reset",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "ratelimit-reset",
]);
const RATE_LIMIT_HEADER_ALIASES = new Map<string, readonly string[]>([
  ["retry-after-ms", ["Retry-After-Ms", "Retry-After-MS", "RETRY-AFTER-MS"]],
  ["retry-after", ["Retry-After", "RETRY-AFTER"]],
  [
    "x-ratelimit-reset",
    ["X-RateLimit-Reset", "X-Ratelimit-Reset", "X-RATELIMIT-RESET"],
  ],
  [
    "x-ratelimit-reset-requests",
    [
      "X-RateLimit-Reset-Requests",
      "X-Ratelimit-Reset-Requests",
      "X-RATELIMIT-RESET-REQUESTS",
    ],
  ],
  [
    "x-ratelimit-reset-tokens",
    [
      "X-RateLimit-Reset-Tokens",
      "X-Ratelimit-Reset-Tokens",
      "X-RATELIMIT-RESET-TOKENS",
    ],
  ],
  [
    "ratelimit-reset",
    ["RateLimit-Reset", "Ratelimit-Reset", "RATELIMIT-RESET"],
  ],
]);

function retryAfterSeconds(value: string): number | undefined {
  const values = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => RETRY_AFTER_SECONDS_RE.test(part));
  if (values.length === 0) {
    return;
  }
  return Math.max(...values.map(Number));
}

function validRetryClock(value: number): boolean {
  return (
    Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
  );
}

function retryAfterDelayMs(value: string, now: number): number | undefined {
  const seconds = retryAfterSeconds(value);
  if (seconds !== undefined) {
    return finiteDelay(seconds * 1000);
  }
  if (!Number.isNaN(Number(value))) {
    return;
  }
  let date = Number.NaN;
  try {
    date = Date.parse(value);
  } catch {
    // A broken date parser must not hide valid secondary reset hints.
  }
  if (!(Number.isFinite(date) && validRetryClock(now))) {
    return;
  }
  return finiteDelay(Math.max(0, date - now));
}

function resetDelayMs(value: string, now: number): number | undefined {
  const trimmed = value.trim().toLowerCase();
  const match = RESET_VALUE_RE.exec(trimmed);
  if (match === null) {
    return;
  }
  const numericValue = Number(match[1]);
  if (!Number.isFinite(numericValue)) {
    return;
  }
  if (match[2] === "ms") {
    return finiteDelay(numericValue);
  }
  if (match[2] === "s") {
    return finiteDelay(numericValue * 1000);
  }
  if (numericValue >= 10_000_000_000) {
    if (!validRetryClock(now)) {
      return;
    }
    return finiteDelay(Math.max(0, numericValue - now));
  }
  if (numericValue >= 1_000_000_000) {
    if (!validRetryClock(now)) {
      return;
    }
    return finiteDelay(Math.max(0, numericValue * 1000 - now));
  }
  const epochDelay = numericValue * 1000 - now;
  return finiteDelay(epochDelay >= 0 ? epochDelay : numericValue * 1000);
}

function resetDelaysMs(value: string, now: number): number[] {
  return value
    .split(",")
    .map((part) => resetDelayMs(part, now))
    .filter((delay): delay is number => delay !== undefined);
}

function retryDelayFromSources(
  sources: readonly HeaderSource[],
  now: number
): number | undefined {
  const retryAfterMilliseconds = headerValues(
    sources,
    "retry-after-ms"
  ).flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => RETRY_AFTER_SECONDS_RE.test(part))
      .map(Number)
      .map((item) => finiteDelay(item))
      .filter((delay): delay is number => delay !== undefined)
  );
  if (retryAfterMilliseconds.length > 0) {
    return Math.max(...retryAfterMilliseconds);
  }
  const retryAfterDelays = headerValues(sources, "retry-after")
    .map((value) => retryAfterDelayMs(value, now))
    .filter((value): value is number => value !== undefined);
  if (retryAfterDelays.length > 0) {
    return Math.max(...retryAfterDelays);
  }
  const resetDelays = [
    "x-ratelimit-reset",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "ratelimit-reset",
  ]
    .flatMap((name) => headerValues(sources, name))
    .flatMap((value) => resetDelaysMs(value, now));
  return resetDelays.length > 0 ? Math.max(...resetDelays) : undefined;
}

function retryAfterMsOfContext(
  error: unknown,
  now?: number,
  captured?: {
    cause: unknown;
    causeResponse: unknown;
    response: unknown;
  }
): number | undefined {
  let decisionNow = now;
  if (decisionNow === undefined) {
    try {
      decisionNow = Date.now();
      if (consumeGenuinePromise(decisionNow)) {
        decisionNow = Number.NaN;
      }
    } catch {
      decisionNow = Number.NaN;
    }
  }
  let context = captured;
  if (context === undefined) {
    const responseValue = safeErrorProperty(error, "response");
    const response = consumeGenuinePromise(responseValue)
      ? undefined
      : responseValue;
    const causeValue = safeErrorProperty(error, "cause");
    const cause = consumeGenuinePromise(causeValue) ? undefined : causeValue;
    const boundedCause = cause === error ? undefined : cause;
    const causeResponseValue = safeErrorProperty(boundedCause, "response");
    context = {
      cause: boundedCause,
      causeResponse: consumeGenuinePromise(causeResponseValue)
        ? undefined
        : causeResponseValue,
      response,
    };
  }
  const seen = new Set<unknown>();
  const topDelay = retryDelayFromSources(
    headerSources(error, context.response, seen),
    decisionNow
  );
  if (topDelay !== undefined) {
    return topDelay;
  }
  return retryDelayFromSources(
    headerSources(context.cause, context.causeResponse, seen),
    decisionNow
  );
}

export function retryAfterMsOf(
  error: unknown,
  now?: number
): number | undefined {
  return retryAfterMsOfContext(error, now);
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
