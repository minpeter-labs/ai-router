import type { LanguageModel } from "ai";

import { AdmissionRegistry } from "./admission-utils";
import { MemoryRouterHealthStore } from "./health-store";
import { boundedEnumerableOwnKeys } from "./http-headers";
import { snapshotFallback } from "./router-fallback-options";
import { RouterLanguageModel } from "./router-language-model";
import { orderingTokenSourceFor } from "./router-options";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";
import type {
  CreateRouterOptions,
  ProviderEntry,
  Router,
  RouterAdmissionSnapshot,
  RouterHealthSnapshot,
  RouterRetryBudgetSnapshot,
} from "./types";

const MAX_ROUTE_CANDIDATES = 10_000;
const MAX_LOGICAL_ROUTES = 10_000;
const MAX_TOTAL_ROUTE_CANDIDATES = 100_000;
const MAX_LOGICAL_ID_LENGTH = 256;

/**
 * A candidate entry normalized to a single internal shape, regardless of which
 * of the three accepted `ProviderEntry` forms the user wrote.
 */
function snapshotRouteEntries(
  logicalId: string,
  entries: unknown
): ProviderEntry[] {
  if (consumeGenuinePromise(entries)) {
    throw new Error(`ai-router: model id "${logicalId}" must be synchronous`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(
      `ai-router: model id "${logicalId}" must map to a provider entry array`
    );
  }
  let entryCount: number;
  try {
    entryCount = Reflect.get(entries, "length");
  } catch {
    throw new Error(
      `ai-router: model id "${logicalId}" candidate array is unreadable`
    );
  }
  if (!Number.isSafeInteger(entryCount) || entryCount < 0) {
    throw new Error(
      `ai-router: model id "${logicalId}" candidate array is unreadable`
    );
  }
  if (entryCount === 0) {
    throw new Error(
      `ai-router: model id "${logicalId}" has no provider entries`
    );
  }
  if (entryCount > MAX_ROUTE_CANDIDATES) {
    throw new Error(
      `ai-router: model id "${logicalId}" exceeds ${MAX_ROUTE_CANDIDATES} candidates`
    );
  }
  consumeOwnDataPromiseFields(
    entries,
    Array.from({ length: entryCount }, (_, index) => index)
  );
  const snapshot: ProviderEntry[] = [];
  let asyncEntry = false;
  for (let index = 0; index < entryCount; index += 1) {
    if (!Object.hasOwn(entries, index)) {
      throw new Error(
        `ai-router: model id "${logicalId}" candidate array must not contain holes`
      );
    }
    try {
      const entry = Reflect.get(entries, index);
      if (consumeGenuinePromise(entry)) {
        asyncEntry = true;
      } else {
        snapshot.push(entry as ProviderEntry);
      }
    } catch {
      throw new Error(
        `ai-router: model id "${logicalId}" candidate entry ${index} is unreadable`
      );
    }
  }
  if (asyncEntry) {
    throw new Error(
      `ai-router: model id "${logicalId}" candidates must be synchronous`
    );
  }
  return snapshot;
}

/** Validate route cardinality before allocating long-lived model state. */
function configuredRoutes(
  models: CreateRouterOptions["models"]
): [string, CreateRouterOptions["models"][string]][] {
  const logicalIds = boundedEnumerableOwnKeys(models, MAX_LOGICAL_ROUTES);
  if (logicalIds === undefined) {
    throw new Error(
      `ai-router: models must contain at most ${MAX_LOGICAL_ROUTES} logical routes`
    );
  }
  consumeOwnDataPromiseFields(models, logicalIds);
  const routes: [string, CreateRouterOptions["models"][string]][] = [];
  let totalCandidates = 0;
  for (const logicalId of logicalIds) {
    if (
      logicalId.trim().length === 0 ||
      logicalId.length > MAX_LOGICAL_ID_LENGTH
    ) {
      throw new Error(
        `ai-router: model ids must be non-empty and at most ${MAX_LOGICAL_ID_LENGTH} characters`
      );
    }
    const entrySnapshot = snapshotRouteEntries(
      logicalId,
      Reflect.get(models, logicalId)
    );
    totalCandidates += entrySnapshot.length;
    if (totalCandidates > MAX_TOTAL_ROUTE_CANDIDATES) {
      throw new Error(
        `ai-router: models exceed ${MAX_TOTAL_ROUTE_CANDIDATES} total candidates`
      );
    }
    routes.push([logicalId, entrySnapshot]);
  }
  return routes;
}

/** Create a modality-aware router with provider fallback. */
export function createRouter(options: CreateRouterOptions): Router {
  if (consumeGenuinePromise(options)) {
    throw new Error("ai-router: createRouter options must be synchronous");
  }
  if (typeof options !== "object" || options === null) {
    throw new Error("ai-router: createRouter options must be an object");
  }
  const keys = ["fallback", "models", "onAttempt", "onError"] as const;
  consumeOwnDataPromiseFields(options, keys);
  const models = options.models;
  const fallback = options.fallback;
  const onAttempt = options.onAttempt;
  const onError = options.onError;
  let asyncOption = false;
  for (const value of [models, fallback, onAttempt, onError]) {
    if (consumeGenuinePromise(value)) {
      asyncOption = true;
    }
  }
  if (asyncOption) {
    throw new Error("ai-router: createRouter options must be synchronous");
  }
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    throw new Error("ai-router: models must be an object of candidate arrays");
  }
  const cache = new Map<string, RouterLanguageModel>();
  const admissionRegistry = new AdmissionRegistry();
  if (onAttempt !== undefined && typeof onAttempt !== "function") {
    throw new Error("ai-router: onAttempt must be a function");
  }
  if (onError !== undefined && typeof onError !== "function") {
    throw new Error("ai-router: onError must be a function");
  }
  const optionSnapshot: CreateRouterOptions = {
    fallback: snapshotFallback(fallback),
    models,
    onAttempt,
    onError,
  };
  const healthStore =
    optionSnapshot.fallback?.healthStore ?? new MemoryRouterHealthStore();
  const ordering = orderingTokenSourceFor(healthStore);

  // Validate every logical route up front without constructing model wrappers
  // or instantiating provider factories. This avoids partial registry growth
  // when a later route pushes the aggregate configuration over its limit.
  // Construction is now bounded and cannot fail due to route cardinality.
  for (const [logicalId, entries] of configuredRoutes(models)) {
    cache.set(
      logicalId,
      new RouterLanguageModel(
        logicalId,
        entries,
        optionSnapshot,
        admissionRegistry,
        healthStore,
        ordering
      )
    );
  }

  const route = (logicalId: string): LanguageModel => {
    const cached = cache.get(logicalId);
    if (cached !== undefined) {
      return cached;
    }
    throw new Error(`ai-router: unknown model id "${logicalId}"`);
  };
  return Object.assign(route, {
    getAdmissionSnapshot(logicalId?: string): RouterAdmissionSnapshot[] {
      if (logicalId !== undefined) {
        if (!cache.has(logicalId)) {
          return [];
        }
        return cache.get(logicalId)?.admissionSnapshot() ?? [];
      }
      return [...cache.values()].flatMap((model) => model.admissionSnapshot());
    },
    getHealthSnapshot(logicalId?: string): RouterHealthSnapshot[] {
      if (logicalId !== undefined) {
        if (!cache.has(logicalId)) {
          return [];
        }
        return cache.get(logicalId)?.healthSnapshot() ?? [];
      }
      const snapshots = [...cache.values()].flatMap((model) =>
        model.healthSnapshot()
      );
      return [
        ...new Map(
          snapshots.map((snapshot) => [snapshot.key, snapshot] as const)
        ).values(),
      ];
    },
    getRetryBudgetSnapshot(logicalId?: string): RouterRetryBudgetSnapshot[] {
      if (logicalId !== undefined) {
        if (!cache.has(logicalId)) {
          return [];
        }
        const snapshot = cache.get(logicalId)?.retryBudgetSnapshot();
        return snapshot === undefined ? [] : [snapshot];
      }
      return [...cache.values()]
        .map((model) => model.retryBudgetSnapshot())
        .filter(
          (snapshot): snapshot is RouterRetryBudgetSnapshot =>
            snapshot !== undefined
        );
    },
  });
}
