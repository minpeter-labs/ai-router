import type { JSONValue } from "@ai-sdk/provider";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "../../core/runtime-types";
import { canonicalJsonValueKey } from "./metadata-details";
import {
  captureStoreMethods,
  currentTime,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_REF_PREFIX,
  DEFAULT_TTL_MS,
  MAX_MEMO_ENTRIES,
  MAX_REF_CREATION_ATTEMPTS,
  type OpenGatewayReasoningDetailsStore,
  type OpenGatewayReasoningDetailsStoreSettings,
  validateSettings,
} from "./reasoning-roundtrip-store";
import {
  isValidReasoningDetailsRef,
  snapshotReasoningDetails,
  snapshotStoreDetails,
} from "./reasoning-roundtrip-store-values";

interface StoredReasoningDetails {
  details: JSONValue[];
  expiresAt: number;
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

export function createReasoningDetailsStore(
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
      if (!isValidReasoningDetailsRef(ref)) {
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

      return snapshotReasoningDetails(stored.details);
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

export function createReasoningDetailsStoreMemo(
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
      if (!isValidReasoningDetailsRef(ref)) {
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
        if (!isValidReasoningDetailsRef(ref)) {
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
