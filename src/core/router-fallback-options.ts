import { safeErrorProperty } from "./error-text";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  isPlainObjectValue,
} from "./runtime-types";
import type {
  FallbackOptions,
  RetryBudgetConfig,
  RouterHealthStore,
} from "./types";

export const capturedHealthStores = new WeakMap<object, RouterHealthStore>();

export function captureHealthStore(store: unknown): RouterHealthStore {
  if (
    !(
      (typeof store === "object" && store !== null) ||
      typeof store === "function"
    )
  ) {
    throw new Error("ai-router: fallback.healthStore must be an object");
  }
  const storeObject = store as object;
  const existing = capturedHealthStores.get(storeObject);
  if (existing !== undefined) {
    return existing;
  }
  const methodNames = [
    "compareAndSet",
    "delete",
    "entries",
    "get",
    "set",
  ] as const;
  consumeOwnDataPromiseFields(storeObject, methodNames);
  const methods = {
    compareAndSet: safeErrorProperty(store, "compareAndSet"),
    delete: safeErrorProperty(store, "delete"),
    entries: safeErrorProperty(store, "entries"),
    get: safeErrorProperty(store, "get"),
    set: safeErrorProperty(store, "set"),
  };
  let asyncMethod = false;
  for (const method of Object.values(methods)) {
    if (consumeGenuinePromise(method)) {
      asyncMethod = true;
    }
  }
  if (asyncMethod) {
    throw new Error(
      "ai-router: fallback.healthStore methods must be synchronous"
    );
  }
  for (const method of ["delete", "get", "set"] as const) {
    if (typeof methods[method] !== "function") {
      throw new Error(
        `ai-router: fallback.healthStore.${method} must be a function`
      );
    }
  }
  for (const method of ["compareAndSet", "entries"] as const) {
    const value = methods[method];
    if (value !== undefined && typeof value !== "function") {
      throw new Error(
        `ai-router: fallback.healthStore.${method} must be a function`
      );
    }
  }
  const deleteMethod = methods.delete as RouterHealthStore["delete"];
  const getMethod = methods.get as RouterHealthStore["get"];
  const setMethod = methods.set as RouterHealthStore["set"];
  const captured: RouterHealthStore = {
    delete(key) {
      return deleteMethod.call(store, key);
    },
    get(key) {
      return getMethod.call(store, key);
    },
    set(key, value) {
      return setMethod.call(store, key, value);
    },
  };
  if (typeof methods.compareAndSet === "function") {
    const compareAndSetMethod = methods.compareAndSet as NonNullable<
      RouterHealthStore["compareAndSet"]
    >;
    captured.compareAndSet = (key, expectedVersion, value) =>
      compareAndSetMethod.call(store, key, expectedVersion, value);
  }
  if (typeof methods.entries === "function") {
    const entriesMethod = methods.entries as NonNullable<
      RouterHealthStore["entries"]
    >;
    captured.entries = () => entriesMethod.call(store);
  }
  capturedHealthStores.set(storeObject, captured);
  return captured;
}

export function snapshotFallback(
  fallback: FallbackOptions | undefined
): FallbackOptions | undefined {
  if (fallback === undefined) {
    return;
  }
  if (consumeGenuinePromise(fallback)) {
    throw new Error("ai-router: fallback must be synchronous");
  }
  if (
    typeof fallback !== "object" ||
    fallback === null ||
    Array.isArray(fallback)
  ) {
    throw new Error("ai-router: fallback must be an options object");
  }
  const keys = [
    "attemptTimeout",
    "backoff",
    "classifyFailure",
    "concurrencyWaitTimeout",
    "cooldown",
    "firstContentTimeout",
    "health",
    "healthNamespace",
    "healthStore",
    "maxAttempts",
    "retryAfterOutput",
    "retryBudget",
    "selection",
    "shouldRetry",
    "strictStreamValidation",
    "totalTimeout",
    "validateResult",
  ] as const;
  consumeOwnDataPromiseFields(fallback, keys);
  const snapshot: FallbackOptions = {
    attemptTimeout: fallback.attemptTimeout,
    backoff: fallback.backoff,
    classifyFailure: fallback.classifyFailure,
    concurrencyWaitTimeout: fallback.concurrencyWaitTimeout,
    cooldown: fallback.cooldown,
    firstContentTimeout: fallback.firstContentTimeout,
    health: fallback.health,
    healthNamespace: fallback.healthNamespace,
    healthStore: fallback.healthStore,
    maxAttempts: fallback.maxAttempts,
    retryAfterOutput: fallback.retryAfterOutput,
    retryBudget: fallback.retryBudget,
    selection: fallback.selection,
    shouldRetry: fallback.shouldRetry,
    strictStreamValidation: fallback.strictStreamValidation,
    totalTimeout: fallback.totalTimeout,
    validateResult: fallback.validateResult,
  };
  let asyncField = false;
  for (const value of Object.values(snapshot)) {
    if (consumeGenuinePromise(value)) {
      asyncField = true;
    }
  }
  if (asyncField) {
    throw new Error("ai-router: fallback options must be synchronous");
  }
  if (snapshot.healthStore !== undefined) {
    snapshot.healthStore = captureHealthStore(snapshot.healthStore);
  }
  if (isPlainObjectValue(snapshot.retryBudget)) {
    const budget = snapshot.retryBudget as RetryBudgetConfig;
    snapshot.retryBudget = {
      maxSamples: budget.maxSamples,
      minSamples: budget.minSamples,
      recoveryFailureRate: budget.recoveryFailureRate,
      tripFailureRate: budget.tripFailureRate,
      window: budget.window,
    };
  }
  if (isPlainObjectValue(snapshot.cooldown)) {
    const cooldown = snapshot.cooldown as { modelResetInterval?: number };
    snapshot.cooldown = {
      modelResetInterval: cooldown.modelResetInterval,
    };
  }
  for (const [name, value] of [
    ["classifyFailure", snapshot.classifyFailure],
    ["shouldRetry", snapshot.shouldRetry],
    ["validateResult", snapshot.validateResult],
  ] as const) {
    if (value !== undefined && typeof value !== "function") {
      throw new Error(`ai-router: fallback.${name} must be a function`);
    }
  }
  for (const [name, value] of [
    ["health", snapshot.health],
    ["retryAfterOutput", snapshot.retryAfterOutput],
    ["strictStreamValidation", snapshot.strictStreamValidation],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`ai-router: fallback.${name} must be a boolean`);
    }
  }
  return snapshot;
}
