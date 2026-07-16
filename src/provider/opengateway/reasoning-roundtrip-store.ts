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
import {
  createReasoningDetailsStore,
  createReasoningDetailsStoreMemo,
} from "./reasoning-roundtrip-store-memory";
import {
  isValidReasoningDetailsRef,
  snapshotStoreDetails,
} from "./reasoning-roundtrip-store-values";

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

export const DEFAULT_MAX_ENTRIES = 1000;
export const DEFAULT_REF_PREFIX = "opengateway-reasoning";
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const MAX_ENTRIES = 100_000;
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_REF_CREATION_ATTEMPTS = 8;
const OPTIONAL_STORE_TIMEOUT_MS = 1000;
export const MAX_MEMO_ENTRIES = 1024;
const MAX_REF_PREFIX_LENGTH = 128;
const INVALID_REF_PREFIX_PATTERN = /[^A-Za-z0-9._~-]/u;

export function validateSettings(
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

export function currentTime(now: () => number): number {
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

export function captureStoreMethods(
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
      if (!isValidReasoningDetailsRef(ref)) {
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
        if (!isValidReasoningDetailsRef(result)) {
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
          if (!isValidReasoningDetailsRef(ref)) {
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

export function createOpenGatewayReasoningDetailsStore(
  settings: OpenGatewayReasoningDetailsStoreSettings = {}
): OpenGatewayReasoningDetailsStore {
  return createReasoningDetailsStore(settings);
}

export function createOpenGatewayReasoningDetailsStoreMemo(
  store: OpenGatewayReasoningDetailsStore
): OpenGatewayReasoningDetailsStore {
  return createReasoningDetailsStoreMemo(store);
}
