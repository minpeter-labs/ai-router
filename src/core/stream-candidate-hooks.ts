import { consumeGenuinePromise } from "./runtime-types";
import { consumeCandidateSnapshotPromiseMutations } from "./stream-candidate-snapshot";
import { ORDERING_TOKEN_RE } from "./stream-part-fields";
import type { ResolvedEntry } from "./stream-types";
import type { RouterOrderingToken } from "./types";

export function isValidOrderingToken(
  value: unknown
): value is RouterOrderingToken {
  return (
    (typeof value === "number" && Number.isFinite(value) && value >= 0) ||
    (typeof value === "string" &&
      value.length <= 256 &&
      ORDERING_TOKEN_RE.test(value))
  );
}

export function requireOptionalBooleanHookResult(
  value: unknown,
  name: string
): boolean {
  if (consumeGenuinePromise(value)) {
    throw new TypeError(`ai-router: ${name} hook must return synchronously`);
  }
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`ai-router: ${name} hook must return a boolean`);
  }
  return value;
}

export function optionalMetricHookValue(
  hook: ((candidate: ResolvedEntry) => number | undefined) | undefined,
  candidate: ResolvedEntry
): number | undefined {
  try {
    const value = invokeReadOnlyCandidateHook(hook, candidate);
    if (consumeGenuinePromise(value)) {
      return;
    }
    return Number.isSafeInteger(value) && (value as number) >= 0
      ? (value as number)
      : undefined;
  } catch {
    return;
  }
}

export function snapshotCandidateForStateHook(
  candidate: ResolvedEntry
): ResolvedEntry {
  const snapshot = {
    entry: candidate.entry,
    fullIndex: candidate.fullIndex,
    ...(candidate.probeLease === undefined
      ? {}
      : { probeLease: { ...candidate.probeLease } }),
  } as ResolvedEntry;
  Object.defineProperty(snapshot, "model", {
    configurable: true,
    enumerable: true,
    get: () => candidate.model,
  });
  return snapshot;
}

export function invokeReadOnlyCandidateHook<Args extends unknown[], Result>(
  hook: ((candidate: ResolvedEntry, ...args: Args) => Result) | undefined,
  candidate: ResolvedEntry,
  ...args: Args
): Result | undefined {
  if (hook === undefined) {
    return;
  }
  const hookCandidate = snapshotCandidateForStateHook(candidate);
  try {
    return hook(hookCandidate, ...args);
  } finally {
    consumeCandidateSnapshotPromiseMutations(hookCandidate);
  }
}

export function captureOptionalHook<T>(
  source: object,
  key: string
): T | undefined {
  const hook = Reflect.get(source, key);
  if (hook === undefined) {
    return;
  }
  if (typeof hook !== "function") {
    throw new TypeError(`ai-router: ${key} hook must be a function`);
  }
  return ((...args: unknown[]) => Reflect.apply(hook, source, args)) as T;
}

export function captureRequiredHook<T>(source: object, key: string): T {
  const hook = captureOptionalHook<T>(source, key);
  if (hook === undefined) {
    throw new TypeError(`ai-router: ${key} hook must be a function`);
  }
  return hook;
}

export function tryCaptureOptionalHook<T>(
  source: object,
  key: string
): { error?: unknown; value?: T } {
  try {
    return { value: captureOptionalHook<T>(source, key) };
  } catch (error) {
    return { error };
  }
}
