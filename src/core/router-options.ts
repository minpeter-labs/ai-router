import { RetryBudget } from "./budget";
import { OrderingTokenSource } from "./ordering";
import type { NormalizedEntry } from "./router-entry";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  isDenseArray,
  isPlainObjectValue,
} from "./runtime-types";
import { durationMs } from "./timeout";
import type { Modality, RetryBudgetConfig, RouterHealthStore } from "./types";

export function validateAdaptiveConcurrency(entry: NormalizedEntry): void {
  const value = entry.adaptiveConcurrency;
  if (value === undefined || value === false || value === true) {
    return;
  }
  if (!isPlainObjectValue(value)) {
    throw new Error(
      "ai-router: adaptiveConcurrency must be a boolean or config object"
    );
  }
  const min = value.min ?? 1;
  const max = value.max ?? Math.max(entry.maxConcurrency ?? 1, 16);
  const initial = value.initial ?? entry.maxConcurrency ?? min;
  const increase = value.increaseAfterSuccesses ?? 10;
  if (
    ![min, max, initial, increase].every(
      (item) => Number.isSafeInteger(item) && item > 0
    ) ||
    min > initial ||
    initial > max
  ) {
    throw new Error(
      "ai-router: adaptiveConcurrency requires positive integers with min <= initial <= max"
    );
  }
}

export const VALID_MODALITIES = new Set<Modality>([
  "text",
  "image",
  "video",
  "audio",
  "pdf",
  "file",
]);
export const MAX_HEALTH_IDENTITY_LENGTH = 256;

export function validateHealthIdentity(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`ai-router: ${name} must not be empty`);
  }
  if (value.length > MAX_HEALTH_IDENTITY_LENGTH) {
    throw new Error(
      `ai-router: ${name} must be at most ${MAX_HEALTH_IDENTITY_LENGTH} characters`
    );
  }
}

export function validateEntryConfiguration(entry: NormalizedEntry): void {
  validateAdaptiveConcurrency(entry);
  if (entry.healthKey !== undefined && typeof entry.healthKey !== "string") {
    throw new Error("ai-router: healthKey must be a string");
  }
  if (
    entry.providerFamily !== undefined &&
    typeof entry.providerFamily !== "string"
  ) {
    throw new Error("ai-router: providerFamily must be a string");
  }
  if (entry.healthKey !== undefined) {
    validateHealthIdentity(entry.healthKey, "healthKey");
  }
  if (entry.providerFamily !== undefined) {
    validateHealthIdentity(entry.providerFamily, "providerFamily");
  }
  if (
    entry.supports !== undefined &&
    !(
      Array.isArray(entry.supports) &&
      entry.supports.length <= VALID_MODALITIES.size &&
      isDenseArray(entry.supports) &&
      entry.supports.every((modality) => VALID_MODALITIES.has(modality))
    )
  ) {
    throw new Error("ai-router: supports contains an unknown modality");
  }
}

export function admissionSignature(entry: NormalizedEntry): string {
  if (
    entry.adaptiveConcurrency === undefined ||
    entry.adaptiveConcurrency === false
  ) {
    return `fixed:${entry.maxConcurrency ?? "unbounded"}`;
  }
  const config =
    typeof entry.adaptiveConcurrency === "object"
      ? entry.adaptiveConcurrency
      : {};
  const min = config.min ?? 1;
  const max = config.max ?? Math.max(entry.maxConcurrency ?? 1, 16);
  return [
    "adaptive",
    config.initial ?? entry.maxConcurrency ?? min,
    min,
    max,
    config.increaseAfterSuccesses ?? 10,
  ].join(":");
}

export function validateSharedAdmission(entries: NormalizedEntry[]): void {
  const signatures = new Map<string, string>();
  for (const entry of entries) {
    if (entry.healthKey === undefined) {
      continue;
    }
    const signature = admissionSignature(entry);
    const existing = signatures.get(entry.healthKey);
    if (existing !== undefined && existing !== signature) {
      throw new Error(
        `ai-router: candidates sharing healthKey "${entry.healthKey}" must use identical concurrency settings`
      );
    }
    signatures.set(entry.healthKey, signature);
  }
}

export function resolveHealthNamespace(
  logicalId: string,
  namespace: string | undefined
): string {
  if (namespace !== undefined) {
    if (typeof namespace !== "string") {
      throw new Error("ai-router: healthNamespace must be a string");
    }
    validateHealthIdentity(namespace, "healthNamespace");
  }
  const logicalSegment = encodeURIComponent(logicalId);
  return namespace === undefined
    ? `logical:${logicalSegment}`
    : `scoped:${encodeURIComponent(namespace)}:${logicalSegment}`;
}

export function resolveSharedHealthNamespace(
  logicalId: string,
  namespace: string | undefined
): string {
  return namespace === undefined
    ? `logical:${encodeURIComponent(logicalId)}`
    : `scope:${encodeURIComponent(namespace)}`;
}

export function createOrderingTokenSource(): OrderingTokenSource {
  return new OrderingTokenSource();
}

export const orderingSources = new WeakMap<
  RouterHealthStore,
  OrderingTokenSource
>();

export function orderingTokenSourceFor(
  healthStore: RouterHealthStore
): OrderingTokenSource {
  const existing = orderingSources.get(healthStore);
  if (existing !== undefined) {
    return existing;
  }
  const source = createOrderingTokenSource();
  orderingSources.set(healthStore, source);
  return source;
}

export function isSignalAborted(signal: AbortSignal | undefined): boolean {
  try {
    const aborted = signal?.aborted;
    return !consumeGenuinePromise(aborted) && aborted === true;
  } catch {
    // An unreadable synthetic signal cannot prove that cancellation occurred.
    return false;
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!isSignalAborted(signal)) {
    return;
  }
  let reason: unknown;
  try {
    reason = signal?.reason;
    if (consumeGenuinePromise(reason)) {
      throw new DOMException("aborted", "AbortError");
    }
  } catch {
    // Accessing a hostile reason may itself throw. Preserve cancellation with
    // a stable AbortError instead of leaking the accessor failure.
    throw new DOMException("aborted", "AbortError");
  }
  throw reason ?? new DOMException("aborted", "AbortError");
}

export function createRetryBudget(
  config: boolean | RetryBudgetConfig | undefined
): RetryBudget | undefined {
  if (config === undefined || config === false) {
    return;
  }
  if (config === true) {
    return new RetryBudget();
  }
  if (consumeGenuinePromise(config)) {
    throw new Error("ai-router: retryBudget must be synchronous");
  }
  if (!isPlainObjectValue(config)) {
    throw new Error(
      "ai-router: retryBudget must be a boolean or config object"
    );
  }
  const keys = [
    "maxSamples",
    "minSamples",
    "recoveryFailureRate",
    "tripFailureRate",
    "window",
  ] as const;
  consumeOwnDataPromiseFields(config, keys);
  const snapshot = {
    maxSamples: config.maxSamples,
    minSamples: config.minSamples,
    recoveryFailureRate: config.recoveryFailureRate,
    tripFailureRate: config.tripFailureRate,
    window: config.window,
  };
  for (const field of Object.values(snapshot)) {
    if (consumeGenuinePromise(field)) {
      throw new Error("ai-router: retryBudget must be synchronous");
    }
  }
  return new RetryBudget(
    Date.now,
    durationMs(snapshot.window as RetryBudgetConfig["window"]) ?? 60_000,
    snapshot as RetryBudgetConfig
  );
}
