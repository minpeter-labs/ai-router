import { consumeGenuinePromise } from "./runtime-types";

const ATTEMPT_PAYLOAD_KEYS = [
  "attempt",
  "concurrencyLimit",
  "durationMs",
  "entry",
  "error",
  "failure",
  "healthTransition",
  "index",
  "inFlight",
  "logicalId",
  "outcome",
  "phase",
  "reason",
  "willRetry",
] as const;

const FAILURE_PAYLOAD_KEYS = [
  "cooldownMs",
  "retryAfterMs",
  "retryable",
  "scope",
  "statusCode",
] as const;

const ERROR_PAYLOAD_KEYS = [
  "entry",
  "error",
  "index",
  "logicalId",
  "phase",
  "willRetry",
] as const;

function ownDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return;
  }
}

function consumeKnownPayloadPromises(
  payload: object,
  keys: readonly string[]
): void {
  for (const key of keys) {
    consumeGenuinePromise(ownDataValue(payload, key));
  }
}

/** Observability hooks must never affect routing or create unhandled rejections. */
export function runObservabilityHook(hook: () => unknown): void {
  try {
    const result = hook();
    consumeGenuinePromise(result);
  } catch {
    // Sync hook failures are intentionally isolated.
  }
}

/** Isolate an attempt hook and consume Promise mutations on its bounded payload. */
export function runAttemptObservabilityHook<T extends object>(
  payload: T,
  hook: (payload: T) => unknown
): void {
  try {
    runObservabilityHook(() => hook(payload));
  } finally {
    const failure = ownDataValue(payload, "failure");
    consumeKnownPayloadPromises(payload, ATTEMPT_PAYLOAD_KEYS);
    if (typeof failure === "object" && failure !== null) {
      consumeKnownPayloadPromises(failure, FAILURE_PAYLOAD_KEYS);
    }
  }
}

/** Isolate an error hook and consume Promise mutations on its bounded payload. */
export function runErrorObservabilityHook<T extends object>(
  payload: T,
  hook: (payload: T) => unknown
): void {
  try {
    runObservabilityHook(() => hook(payload));
  } finally {
    consumeKnownPayloadPromises(payload, ERROR_PAYLOAD_KEYS);
  }
}
