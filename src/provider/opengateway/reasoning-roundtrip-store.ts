import type { JSONValue } from "@ai-sdk/provider";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  requireGenuinePromise,
} from "../../core/runtime-types";
import { clearTimerSafely, scheduleTimer } from "../../core/timeout";
import {
  captureCallbackJsonMutationTargets,
  consumeCallbackJsonMutationPromises,
} from "./callback-json-mutations";
import { appendUniqueJsonDetails, canonicalJsonValueKey } from "./metadata";

export const REASONING_DETAILS_REF_KEY = "reasoningDetailsRef";

export interface OpenGatewayReasoningDetailsStore {
  load(
    ref: string
  ):
    | readonly JSONValue[]
    | undefined
    | Promise<readonly JSONValue[] | undefined>;
  store(details: readonly JSONValue[]): string | Promise<string>;
}

export interface OpenGatewayReasoningDetailsStoreSettings {
  maxEntries?: number;
  now?: () => number;
  refPrefix?: string;
  ttlMs?: number;
}

interface StoredReasoningDetails {
  readonly details: readonly JSONValue[];
  readonly expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_REF_PREFIX = "opengateway-reasoning";
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 100_000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REF_CREATION_ATTEMPTS = 8;
const OPTIONAL_STORE_TIMEOUT_MS = 1000;
const MAX_MEMO_ENTRIES = 1024;
const MAX_REF_PREFIX_LENGTH = 128;
const MAX_REF_LENGTH = 256;
const INVALID_REF_PREFIX_PATTERN = /[^A-Za-z0-9._~-]/u;

function validateSettings(
  maxEntries: number,
  now: () => number,
  refPrefix: string,
  ttlMs: number
): void {
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > MAX_ENTRIES
  ) {
    throw new TypeError(
      `reasoningDetailsRef maxEntries must be an integer from 1 to ${MAX_ENTRIES}`
    );
  }
  if (typeof now !== "function") {
    throw new TypeError("reasoningDetailsRef now must be a function");
  }
  if (
    typeof refPrefix !== "string" ||
    refPrefix.length === 0 ||
    refPrefix.length > MAX_REF_PREFIX_LENGTH ||
    INVALID_REF_PREFIX_PATTERN.test(refPrefix)
  ) {
    throw new TypeError("reasoningDetailsRef refPrefix is invalid");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new TypeError(
      `reasoningDetailsRef ttlMs must be an integer from 1 to ${MAX_TTL_MS}`
    );
  }
}

function currentTime(now: () => number): number {
  const value = now();
  if (consumeGenuinePromise(value) || !Number.isSafeInteger(value)) {
    throw new TypeError("reasoningDetailsRef clock must return a safe integer");
  }
  return value;
}

function settleOptionalStore<T>(
  promise: Promise<T>,
  operation: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const succeed = (value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimerSafely(timer);
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimerSafely(timer);
      reject(error);
    };
    try {
      timer = scheduleTimer(
        () => fail(new Error(`reasoningDetailsStore ${operation} timed out`)),
        OPTIONAL_STORE_TIMEOUT_MS
      );
    } catch (error) {
      consumeGenuinePromise(promise);
      fail(error);
      return;
    }
    Promise.prototype.then.call(promise, succeed, fail);
  });
}

function captureStoreMethods(
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): OpenGatewayReasoningDetailsStore {
  if (consumeGenuinePromise(reasoningDetailsStore)) {
    throw new TypeError("reasoningDetailsStore must be synchronous");
  }
  if (
    (typeof reasoningDetailsStore !== "object" ||
      reasoningDetailsStore === null) &&
    typeof reasoningDetailsStore !== "function"
  ) {
    throw new TypeError("reasoningDetailsStore must be an object");
  }
  consumeOwnDataPromiseFields(reasoningDetailsStore, ["load", "store"]);
  const load = reasoningDetailsStore.load;
  const store = reasoningDetailsStore.store;
  const asyncLoad = consumeGenuinePromise(load);
  const asyncStore = consumeGenuinePromise(store);
  if (asyncLoad || asyncStore) {
    throw new TypeError("reasoningDetailsStore methods must be synchronous");
  }
  if (typeof load !== "function" || typeof store !== "function") {
    throw new TypeError(
      "reasoningDetailsStore must provide load and store methods"
    );
  }
  return {
    load(ref) {
      if (!isValidRef(ref)) {
        return;
      }
      const result = load.call(reasoningDetailsStore, ref);
      if (result === undefined) {
        return;
      }
      if (Array.isArray(result)) {
        return snapshotStoreDetails(result);
      }
      return settleOptionalStore(
        requireGenuinePromise<readonly JSONValue[] | undefined>(
          result,
          (error) =>
            new TypeError(
              "reasoningDetailsStore load must return a genuine Promise",
              { cause: error }
            )
        ),
        "load"
      ).then((details) =>
        details === undefined ? undefined : snapshotStoreDetails(details)
      );
    },
    store(details) {
      const detailsSnapshot = snapshotStoreDetails(details);
      const mutationTargets =
        captureCallbackJsonMutationTargets(detailsSnapshot);
      let result: ReturnType<OpenGatewayReasoningDetailsStore["store"]>;
      try {
        result = store.call(reasoningDetailsStore, detailsSnapshot);
      } finally {
        consumeCallbackJsonMutationPromises(mutationTargets);
      }
      if (typeof result === "string") {
        if (!isValidRef(result)) {
          throw new TypeError("reasoningDetailsStore returned an invalid ref");
        }
        return result;
      }
      const settled = settleOptionalStore(
        requireGenuinePromise<string>(
          result,
          (error) =>
            new TypeError(
              "reasoningDetailsStore store must return a genuine Promise",
              { cause: error }
            )
        ),
        "store"
      );
      return settled.then(
        (ref) => {
          consumeCallbackJsonMutationPromises(mutationTargets);
          if (!isValidRef(ref)) {
            throw new TypeError(
              "reasoningDetailsStore returned an invalid ref"
            );
          }
          return ref;
        },
        (error) => {
          consumeCallbackJsonMutationPromises(mutationTargets);
          throw error;
        }
      );
    },
  };
}

export function captureOpenGatewayReasoningDetailsStore(
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): OpenGatewayReasoningDetailsStore {
  return captureStoreMethods(reasoningDetailsStore);
}

function snapshotDetails(details: readonly JSONValue[]): JSONValue[] {
  const snapshot: JSONValue[] = [];
  appendUniqueJsonDetails(snapshot, details);
  return snapshot;
}

function snapshotStoreDetails(value: unknown): JSONValue[] {
  const asyncDetails = consumeGenuinePromise(value);
  if (asyncDetails || !Array.isArray(value)) {
    throw new TypeError(
      "reasoningDetailsStore details must be synchronous array"
    );
  }
  return snapshotDetails(value);
}

function isValidRef(ref: unknown): ref is string {
  if (consumeGenuinePromise(ref)) {
    return false;
  }
  return (
    typeof ref === "string" && ref.length > 0 && ref.length <= MAX_REF_LENGTH
  );
}

function detailsKey(details: readonly JSONValue[]): string {
  return canonicalJsonValueKey(details as JSONValue[]);
}

function createRandomRef(prefix: string): string {
  const crypto = globalThis.crypto;
  if (typeof crypto !== "object" || crypto === null) {
    throw new Error("OpenGateway reasoningDetailsRef requires Web Crypto");
  }
  const randomUUID = Reflect.get(crypto, "randomUUID");
  if (consumeGenuinePromise(randomUUID)) {
    throw new TypeError("reasoningDetailsRef randomUUID must be synchronous");
  }
  if (randomUUID != null) {
    if (typeof randomUUID !== "function") {
      throw new TypeError("reasoningDetailsRef randomUUID must be a function");
    }
    const uuid = Reflect.apply(randomUUID, crypto, []);
    if (
      consumeGenuinePromise(uuid) ||
      typeof uuid !== "string" ||
      uuid.length === 0 ||
      uuid.length > 128
    ) {
      throw new TypeError(
        "reasoningDetailsRef randomUUID must return a synchronous bounded string"
      );
    }
    return `${prefix}-${uuid}`;
  }

  const getRandomValues = Reflect.get(crypto, "getRandomValues");
  if (consumeGenuinePromise(getRandomValues)) {
    throw new TypeError(
      "reasoningDetailsRef getRandomValues must be synchronous"
    );
  }
  if (getRandomValues != null) {
    if (typeof getRandomValues !== "function") {
      throw new TypeError(
        "reasoningDetailsRef getRandomValues must be a function"
      );
    }
    const bytes = new Uint8Array(16);
    const result = Reflect.apply(getRandomValues, crypto, [bytes]);
    if (consumeGenuinePromise(result) || result !== bytes) {
      throw new TypeError(
        "reasoningDetailsRef getRandomValues must return synchronously"
      );
    }
    return `${prefix}-${Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")}`;
  }

  throw new Error("OpenGateway reasoningDetailsRef requires Web Crypto");
}

export function createOpenGatewayReasoningDetailsStore(
  settings: OpenGatewayReasoningDetailsStoreSettings = {}
): OpenGatewayReasoningDetailsStore {
  if (consumeGenuinePromise(settings)) {
    throw new TypeError("reasoningDetailsRef settings must be synchronous");
  }
  if (typeof settings !== "object" || settings === null) {
    throw new TypeError("reasoningDetailsRef settings must be an object");
  }
  consumeOwnDataPromiseFields(settings, [
    "maxEntries",
    "now",
    "refPrefix",
    "ttlMs",
  ]);
  const capturedMaxEntries = settings.maxEntries;
  const capturedNow = settings.now;
  const capturedRefPrefix = settings.refPrefix;
  const capturedTtlMs = settings.ttlMs;
  const asyncMaxEntries = consumeGenuinePromise(capturedMaxEntries);
  const asyncNow = consumeGenuinePromise(capturedNow);
  const asyncRefPrefix = consumeGenuinePromise(capturedRefPrefix);
  const asyncTtlMs = consumeGenuinePromise(capturedTtlMs);
  if (asyncMaxEntries || asyncNow || asyncRefPrefix || asyncTtlMs) {
    throw new TypeError("reasoningDetailsRef settings must be synchronous");
  }
  const maxEntries =
    capturedMaxEntries === undefined ? DEFAULT_MAX_ENTRIES : capturedMaxEntries;
  const now = capturedNow === undefined ? Date.now : capturedNow;
  const refPrefix =
    capturedRefPrefix === undefined ? DEFAULT_REF_PREFIX : capturedRefPrefix;
  const ttlMs = capturedTtlMs === undefined ? DEFAULT_TTL_MS : capturedTtlMs;
  validateSettings(maxEntries, now, refPrefix, ttlMs);
  const reasoningDetailsByRef = new Map<string, StoredReasoningDetails>();
  let latestTime = Number.MIN_SAFE_INTEGER;

  function monotonicCurrentTime(): number {
    latestTime = Math.max(latestTime, currentTime(now));
    return latestTime;
  }

  function pruneExpired(currentTime: number): void {
    for (const [ref, stored] of reasoningDetailsByRef) {
      if (stored.expiresAt > currentTime) {
        return;
      }
      reasoningDetailsByRef.delete(ref);
    }
  }

  function pruneOverflow(): void {
    while (reasoningDetailsByRef.size > maxEntries) {
      const oldestRef = reasoningDetailsByRef.keys().next().value;
      if (typeof oldestRef !== "string") {
        return;
      }
      reasoningDetailsByRef.delete(oldestRef);
    }
  }

  return {
    load(ref) {
      if (!isValidRef(ref)) {
        return;
      }
      const time = monotonicCurrentTime();
      const stored = reasoningDetailsByRef.get(ref);
      if (stored == null) {
        return;
      }

      if (stored.expiresAt <= time) {
        reasoningDetailsByRef.delete(ref);
        return;
      }

      return snapshotDetails(stored.details);
    },
    store(details) {
      const time = monotonicCurrentTime();
      pruneExpired(time);
      const detailsSnapshot = snapshotStoreDetails(details);

      let ref: string | undefined;
      for (let attempt = 0; attempt < MAX_REF_CREATION_ATTEMPTS; attempt += 1) {
        const candidate = createRandomRef(refPrefix);
        if (!reasoningDetailsByRef.has(candidate)) {
          ref = candidate;
          break;
        }
      }
      if (ref === undefined) {
        throw new Error(
          "OpenGateway reasoningDetailsRef collision limit reached"
        );
      }
      reasoningDetailsByRef.set(ref, {
        details: detailsSnapshot,
        expiresAt: Math.min(Number.MAX_SAFE_INTEGER, time + ttlMs),
      });
      pruneOverflow();

      return ref;
    },
  };
}

export function createOpenGatewayReasoningDetailsStoreMemo(
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): OpenGatewayReasoningDetailsStore {
  const refsByDetails = new Map<string, Promise<string>>();
  const detailsByRef = new Map<
    string,
    Promise<readonly JSONValue[] | undefined>
  >();
  const capturedStore = captureStoreMethods(reasoningDetailsStore);

  return {
    load(ref) {
      if (!isValidRef(ref)) {
        return;
      }
      const cached = detailsByRef.get(ref);
      if (cached !== undefined) {
        return cached;
      }
      if (detailsByRef.size >= MAX_MEMO_ENTRIES) {
        return;
      }
      let result: ReturnType<OpenGatewayReasoningDetailsStore["load"]>;
      try {
        result = capturedStore.load(ref);
      } catch (error) {
        return Promise.reject(error);
      }
      const promise = Promise.resolve(result);
      detailsByRef.set(ref, promise);
      promise.catch(() => {
        if (detailsByRef.get(ref) === promise) {
          detailsByRef.delete(ref);
        }
      });
      return promise;
    },
    store(details) {
      const detailsSnapshot = snapshotStoreDetails(details);
      const key = detailsKey(detailsSnapshot);
      const cachedRef = refsByDetails.get(key);
      if (cachedRef !== undefined) {
        return cachedRef;
      }
      if (refsByDetails.size >= MAX_MEMO_ENTRIES) {
        try {
          return capturedStore.store(detailsSnapshot);
        } catch (error) {
          return Promise.reject(error);
        }
      }

      let result: ReturnType<OpenGatewayReasoningDetailsStore["store"]>;
      try {
        result = capturedStore.store(detailsSnapshot);
      } catch (error) {
        return Promise.reject(error);
      }
      const refPromise = Promise.resolve(result).then((ref) => {
        if (!isValidRef(ref)) {
          throw new TypeError("reasoningDetailsStore returned an invalid ref");
        }
        return ref;
      });
      refsByDetails.set(key, refPromise);
      refPromise.catch(() => {
        if (refsByDetails.get(key) === refPromise) {
          refsByDetails.delete(key);
        }
      });
      return refPromise;
    },
  };
}
