import { safeErrorProperty } from "./error-text";
import {
  type HeaderSource,
  headerSources,
  headerValues,
} from "./failure-headers";
import { consumeGenuinePromise } from "./runtime-types";

const RESET_VALUE_RE = /^(\d+(?:\.\d+)?(?:e[+-]?\d+)?)(ms|s)?$/i;
const RETRY_AFTER_SECONDS_RE = /^\d+(?:\.\d+)?$/;

function finiteDelay(value: number): number | undefined {
  if (value === Number.POSITIVE_INFINITY) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (!Number.isFinite(value) || value < 0) {
    return;
  }
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

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

export function retryAfterMsOfContext(
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
