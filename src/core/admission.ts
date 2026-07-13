import { addCapturedAbortListener } from "./abort-signal";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";
import { clearTimerSafely, monotonicNow, scheduleTimer } from "./timeout";
import type {
  AdaptiveConcurrencyConfig,
  FailureClassification,
  RouterOrderingToken,
} from "./types";

const MAX_ROUND_ROBIN_POOLS = 1024;
const MAX_ROUND_ROBIN_POOL_KEY_CHARS = 1_048_576;
const MAX_WAITERS_PER_KEY = 10_000;
const ADMISSION_ORDERING_TOKEN_RE = /^v1:(\d+):([^:]+):(\d+)$/;

function roundRobinPoolKey(
  candidates: readonly { fullIndex: number }[]
): string {
  return candidates.map(({ fullIndex }) => fullIndex).join(",");
}

export interface AdmissionEntry {
  adaptiveConcurrency?: boolean | AdaptiveConcurrencyConfig;
  healthKey?: string;
  maxConcurrency?: number;
}

export interface AdmissionSnapshot {
  adaptive: boolean;
  increaseAfterSuccesses?: number;
  index: number;
  inFlight: number;
  limit?: number;
  max?: number;
  min?: number;
  successes?: number;
  waiting: number;
}

export class RouterConcurrencyError extends Error {
  readonly code = "concurrency_exhausted";
  readonly logicalId: string;

  constructor(logicalId: string) {
    super(
      `ai-router: all compatible candidates for "${logicalId}" are at their concurrency limit`
    );
    this.name = "RouterConcurrencyError";
    this.logicalId = logicalId;
  }
}

interface AdaptiveState {
  increaseAfterSuccesses: number;
  lastOutcomeOrderingToken?: RouterOrderingToken;
  lastOutcomeStartedAt?: number;
  limit: number;
  max: number;
  min: number;
  successes: number;
}

function normalizedAdaptiveState(value: unknown): AdaptiveState | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  try {
    const record = value as Record<string, unknown>;
    const state = {
      increaseAfterSuccesses: record.increaseAfterSuccesses,
      lastOutcomeOrderingToken: record.lastOutcomeOrderingToken,
      lastOutcomeStartedAt: record.lastOutcomeStartedAt,
      limit: record.limit,
      max: record.max,
      min: record.min,
      successes: record.successes,
    };
    if (
      !(
        Number.isSafeInteger(state.min) &&
        (state.min as number) >= 1 &&
        Number.isSafeInteger(state.max) &&
        (state.max as number) >= (state.min as number) &&
        Number.isSafeInteger(state.limit) &&
        (state.limit as number) >= (state.min as number) &&
        (state.limit as number) <= (state.max as number) &&
        Number.isSafeInteger(state.increaseAfterSuccesses) &&
        (state.increaseAfterSuccesses as number) >= 1 &&
        Number.isSafeInteger(state.successes) &&
        (state.successes as number) >= 0 &&
        (state.lastOutcomeStartedAt === undefined ||
          (typeof state.lastOutcomeStartedAt === "number" &&
            Number.isFinite(state.lastOutcomeStartedAt) &&
            state.lastOutcomeStartedAt >= 0)) &&
        (state.lastOutcomeOrderingToken === undefined ||
          (typeof state.lastOutcomeOrderingToken === "number" &&
            Number.isFinite(state.lastOutcomeOrderingToken) &&
            state.lastOutcomeOrderingToken >= 0) ||
          (typeof state.lastOutcomeOrderingToken === "string" &&
            state.lastOutcomeOrderingToken.length <= 256))
      )
    ) {
      return;
    }
    return state as AdaptiveState;
  } catch {
    return;
  }
}

interface Waiter {
  acquire: () => number | undefined;
  resolve: (value: number | undefined) => void;
}

function isValidWaiterSlot(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isCongestionFailure(
  failure: FailureClassification | undefined
): boolean {
  if (failure === undefined) {
    return false;
  }
  if (failure.scope === "credential" || failure.statusCode === 429) {
    return true;
  }
  return (
    failure.retryable &&
    (failure.statusCode === 408 ||
      failure.statusCode === 425 ||
      (failure.statusCode !== undefined && failure.statusCode >= 500))
  );
}

function staleAdaptiveOutcome(
  state: AdaptiveState,
  attemptStartedAt: number | undefined,
  orderingToken: RouterOrderingToken | undefined
): boolean {
  if (
    attemptStartedAt === undefined ||
    state.lastOutcomeStartedAt === undefined
  ) {
    return false;
  }
  if (attemptStartedAt !== state.lastOutcomeStartedAt) {
    return attemptStartedAt < state.lastOutcomeStartedAt;
  }
  const previous = state.lastOutcomeOrderingToken;
  if (previous === undefined || orderingToken === undefined) {
    return false;
  }
  if (typeof previous === "number" && typeof orderingToken === "number") {
    return orderingToken < previous;
  }
  if (typeof previous === "string" && typeof orderingToken === "string") {
    return compareAdaptiveOrderingTokens(orderingToken, previous) < 0;
  }
  return false;
}

function compareAdaptiveOrderingTokens(left: string, right: string): number {
  const leftMatch = ADMISSION_ORDERING_TOKEN_RE.exec(left);
  const rightMatch = ADMISSION_ORDERING_TOKEN_RE.exec(right);
  if (leftMatch === null || rightMatch === null) {
    return left < right ? -1 : Number(left > right);
  }
  const timestampOrder = BigInt(leftMatch[1]) - BigInt(rightMatch[1]);
  if (timestampOrder !== 0n) {
    return timestampOrder < 0n ? -1 : 1;
  }
  if (leftMatch[2] !== rightMatch[2]) {
    return leftMatch[2] < rightMatch[2] ? -1 : 1;
  }
  const counterOrder = BigInt(leftMatch[3]) - BigInt(rightMatch[3]);
  return counterOrder < 0n ? -1 : Number(counterOrder > 0n);
}

function retainAdaptiveOutcomeOrder(
  state: AdaptiveState,
  attemptStartedAt: number | undefined,
  orderingToken: RouterOrderingToken | undefined
): void {
  if (
    attemptStartedAt === undefined ||
    !Number.isFinite(attemptStartedAt) ||
    attemptStartedAt < 0
  ) {
    return;
  }
  state.lastOutcomeStartedAt = attemptStartedAt;
  if (
    (typeof orderingToken === "number" &&
      Number.isFinite(orderingToken) &&
      orderingToken >= 0) ||
    (typeof orderingToken === "string" && orderingToken.length <= 256)
  ) {
    state.lastOutcomeOrderingToken = orderingToken;
  } else {
    state.lastOutcomeOrderingToken = undefined;
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  try {
    const reason = signal?.reason;
    return consumeGenuinePromise(reason)
      ? new DOMException("aborted", "AbortError")
      : (reason ?? new DOMException("aborted", "AbortError"));
  } catch {
    return new DOMException("aborted", "AbortError");
  }
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  try {
    const aborted = signal?.aborted;
    return !consumeGenuinePromise(aborted) && aborted === true;
  } catch {
    return false;
  }
}

function captureUsableWaiter(value: unknown): Waiter | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  try {
    consumeOwnDataPromiseFields(value, ["acquire", "resolve"]);
    const acquire = Reflect.get(value, "acquire");
    const resolve = Reflect.get(value, "resolve");
    const asyncAcquire = consumeGenuinePromise(acquire);
    const asyncResolve = consumeGenuinePromise(resolve);
    if (
      asyncAcquire ||
      asyncResolve ||
      typeof acquire !== "function" ||
      typeof resolve !== "function"
    ) {
      return;
    }
    return {
      acquire: () => Reflect.apply(acquire, value, []),
      resolve: (slot) => Reflect.apply(resolve, value, [slot]),
    };
  } catch {
    return;
  }
}

export class AdmissionRegistry {
  readonly adaptiveStates = new Map<string, AdaptiveState>();
  readonly configurations = new Map<string, string>();
  readonly inFlightCounts = new Map<string, number>();
  readonly waiters = new Map<string, Waiter[]>();
}

export class AdmissionController {
  private readonly entries: AdmissionEntry[];
  private readonly scope: string;
  private readonly waitTimeout?: number;
  private readonly registry: AdmissionRegistry;
  private readonly roundRobinCursors = new Map<string, number>();
  private roundRobinPoolKeyChars = 0;

  constructor(
    entries: AdmissionEntry[],
    waitTimeout?: number,
    scope = "default",
    registry = new AdmissionRegistry()
  ) {
    if (
      waitTimeout !== undefined &&
      (!Number.isSafeInteger(waitTimeout) ||
        waitTimeout <= 0 ||
        waitTimeout > 86_400_000)
    ) {
      throw new Error(
        "ai-router: admission wait timeout must be a positive safe duration at most 24h"
      );
    }
    this.entries = entries;
    this.waitTimeout = waitTimeout;
    this.scope = scope;
    this.registry = registry;
    this.registerSharedConfigurations();
  }

  acquire(index: number): number | undefined {
    const limit = this.limit(index);
    const key = this.key(index);
    const current = this.normalizedInFlight(key);
    if (
      current >= Number.MAX_SAFE_INTEGER ||
      (limit !== undefined && current >= limit)
    ) {
      return;
    }
    const next = current + 1;
    this.registry.inFlightCounts.set(key, next);
    return next;
  }

  canAcquire(index: number): boolean {
    return this.canAcquireWithCurrent(index, this.inFlight(index));
  }

  canAcquireAfterRelease(index: number, releasingIndex: number): boolean {
    const current = this.inFlight(index);
    const effectiveCurrent =
      this.key(index) === this.key(releasingIndex) && current > 0
        ? current - 1
        : current;
    return this.canAcquireWithCurrent(index, effectiveCurrent);
  }

  private canAcquireWithCurrent(index: number, current: number): boolean {
    const limit = this.limit(index);
    return (
      current < Number.MAX_SAFE_INTEGER &&
      (limit === undefined || current < limit)
    );
  }

  release(index: number): void {
    const key = this.key(index);
    const current = this.normalizedInFlight(key);
    if (current === 0) {
      return;
    }
    const next = current - 1;
    if (next === 0) {
      this.registry.inFlightCounts.delete(key);
    } else {
      this.registry.inFlightCounts.set(key, next);
    }

    this.drainWaiters(key);
  }

  private drainWaiters(key: string): void {
    let queue = this.normalizedWaiters(key);
    while (queue !== undefined) {
      if (queue.length === 0) {
        if (this.registry.waiters.get(key) !== queue) {
          queue = this.normalizedWaiters(key);
          continue;
        }
        break;
      }
      const waiter = queue[0] as unknown;
      const capturedWaiter = captureUsableWaiter(waiter);
      if (capturedWaiter === undefined) {
        queue.shift();
        continue;
      }
      let slot: number | undefined;
      const beforeAcquire = this.normalizedInFlight(key);
      try {
        slot = capturedWaiter.acquire();
      } catch {
        this.rollbackWaiterAcquire(key, beforeAcquire);
        queue.shift();
        continue;
      }
      if (slot === undefined) {
        this.rollbackWaiterAcquire(key, beforeAcquire);
        break;
      }
      if (!isValidWaiterSlot(slot)) {
        this.rollbackWaiterAcquire(key, beforeAcquire);
        queue.shift();
        continue;
      }
      queue.shift();
      try {
        const result = capturedWaiter.resolve(slot);
        if (result !== undefined) {
          consumeGenuinePromise(result);
          this.rollbackWaiterAcquire(key, beforeAcquire);
        }
      } catch {
        this.rollbackWaiterAcquire(key, beforeAcquire);
      }
    }
    if (queue?.length === 0 && this.registry.waiters.get(key) === queue) {
      this.registry.waiters.delete(key);
    }
  }

  private rollbackWaiterAcquire(key: string, beforeAcquire: number): void {
    const current = this.normalizedInFlight(key);
    if (current <= beforeAcquire) {
      return;
    }
    const next = current - 1;
    if (next === 0) {
      this.registry.inFlightCounts.delete(key);
    } else {
      this.registry.inFlightCounts.set(key, next);
    }
  }

  waitFor(
    index: number,
    signal: AbortSignal | undefined,
    deadline: number | undefined
  ): Promise<number | undefined> {
    if (this.waitTimeout === undefined) {
      return Promise.resolve(undefined);
    }
    if (deadline !== undefined && Number.isNaN(deadline)) {
      return Promise.resolve(undefined);
    }
    const remaining =
      deadline === undefined || deadline === Number.POSITIVE_INFINITY
        ? this.waitTimeout
        : deadline - monotonicNow();
    // Node and browsers truncate fractional timer delays. Round up so a wait
    // bounded by the total deadline cannot wake a fraction early and surface
    // the preceding provider error instead of the deadline timeout.
    const waitMs = Math.ceil(
      Math.max(0, Math.min(this.waitTimeout, remaining))
    );
    if (isSignalAborted(signal)) {
      return Promise.reject(abortReason(signal));
    }
    if (waitMs === 0) {
      return Promise.resolve(undefined);
    }
    const key = this.key(index);
    const queue = this.normalizedWaiters(key) ?? [];
    if (queue.length >= MAX_WAITERS_PER_KEY) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let removeSignalAbort: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: Waiter = {
        acquire: () => this.acquire(index),
        resolve: (value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimerSafely(timer);
          removeSignalAbort?.();
          resolve(value);
        },
      };
      const remove = () => {
        const currentQueue = this.normalizedWaiters(key);
        if (currentQueue === undefined) {
          return;
        }
        const position = currentQueue.indexOf(entry);
        if (position !== -1) {
          currentQueue.splice(position, 1);
        }
        if (currentQueue.length === 0) {
          this.registry.waiters.delete(key);
        }
      };
      const onAbort = () => {
        remove();
        if (settled) {
          return;
        }
        settled = true;
        clearTimerSafely(timer);
        removeSignalAbort?.();
        reject(abortReason(signal));
      };
      timer = scheduleTimer(() => {
        remove();
        entry.resolve(undefined);
      }, waitMs);
      if (settled) {
        return;
      }
      queue.push(entry);
      this.registry.waiters.set(key, queue);
      try {
        if (signal !== undefined) {
          removeSignalAbort = addCapturedAbortListener(signal, onAbort);
          if (settled) {
            removeSignalAbort();
            return;
          }
        }
        if (isSignalAborted(signal)) {
          onAbort();
        }
      } catch (error) {
        remove();
        removeSignalAbort?.();
        if (!settled) {
          settled = true;
          clearTimerSafely(timer);
          reject(error);
        }
      }
    });
  }

  inFlight(index: number): number {
    return this.normalizedInFlight(this.key(index));
  }

  limit(index: number): number | undefined {
    const entry = this.entries[index];
    if (
      entry.adaptiveConcurrency === undefined ||
      entry.adaptiveConcurrency === false
    ) {
      return entry.maxConcurrency;
    }
    return this.adaptiveState(index).limit;
  }

  observe(
    index: number,
    success: boolean,
    failure?: FailureClassification,
    attemptStartedAt?: number,
    orderingToken?: RouterOrderingToken
  ): void {
    const adaptive = this.entries[index].adaptiveConcurrency;
    if (adaptive === undefined || adaptive === false) {
      return;
    }
    const state = this.adaptiveState(index);
    if (!success) {
      if (failure?.scope === "request") {
        return;
      }
      if (staleAdaptiveOutcome(state, attemptStartedAt, orderingToken)) {
        return;
      }
      retainAdaptiveOutcomeOrder(state, attemptStartedAt, orderingToken);
      state.successes = 0;
      if (isCongestionFailure(failure)) {
        state.limit = Math.max(state.min, Math.floor(state.limit / 2));
      }
      return;
    }
    if (staleAdaptiveOutcome(state, attemptStartedAt, orderingToken)) {
      return;
    }
    retainAdaptiveOutcomeOrder(state, attemptStartedAt, orderingToken);
    state.successes += 1;
    if (state.successes >= state.increaseAfterSuccesses) {
      state.limit = Math.min(state.max, state.limit + 1);
      state.successes = 0;
    }
  }

  snapshot(index: number): AdmissionSnapshot {
    const entry = this.entries[index];
    const key = this.key(index);
    const base = {
      inFlight: this.normalizedInFlight(key),
      index,
      waiting: this.normalizedWaiters(key)?.length ?? 0,
    };
    if (
      entry.adaptiveConcurrency === undefined ||
      entry.adaptiveConcurrency === false
    ) {
      return {
        ...base,
        adaptive: false,
        ...(entry.maxConcurrency === undefined
          ? {}
          : { limit: entry.maxConcurrency }),
      };
    }
    const state = this.adaptiveState(index);
    return {
      ...base,
      adaptive: true,
      increaseAfterSuccesses: state.increaseAfterSuccesses,
      limit: state.limit,
      max: state.max,
      min: state.min,
      successes: state.successes,
    };
  }

  reorder<T extends { fullIndex: number }>(
    candidates: T[],
    selection: "least-inflight" | "ordered" | "round-robin"
  ): void {
    if (candidates.length < 2) {
      return;
    }
    if (selection === "least-inflight") {
      candidates.sort(
        (left, right) =>
          this.inFlight(left.fullIndex) - this.inFlight(right.fullIndex)
      );
      return;
    }
    if (selection === "round-robin") {
      const pool = roundRobinPoolKey(candidates);
      const cursor = this.roundRobinCursors.get(pool) ?? 0;
      const offset = cursor % candidates.length;
      // Refresh insertion order for bounded LRU-style retention. Candidate
      // pools can vary with modality and health filtering in long-lived routers.
      const existed = this.roundRobinCursors.delete(pool);
      if (!existed) {
        this.roundRobinPoolKeyChars += pool.length;
      }
      this.roundRobinCursors.set(pool, (offset + 1) % candidates.length);
      while (
        this.roundRobinCursors.size > MAX_ROUND_ROBIN_POOLS ||
        this.roundRobinPoolKeyChars > MAX_ROUND_ROBIN_POOL_KEY_CHARS
      ) {
        const oldest = this.roundRobinCursors.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.roundRobinCursors.delete(oldest);
        this.roundRobinPoolKeyChars -= oldest.length;
      }
      candidates.push(...candidates.splice(0, offset));
    }
  }

  private key(index: number): string {
    return this.entries[index].healthKey === undefined
      ? `${this.scope}:unit:${index}`
      : `credential:${this.entries[index].healthKey}`;
  }

  private normalizedInFlight(key: string): number {
    const value = this.registry.inFlightCounts.get(key);
    if (value === undefined) {
      return 0;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      this.registry.inFlightCounts.delete(key);
      return 0;
    }
    return value;
  }

  private normalizedWaiters(key: string): Waiter[] | undefined {
    const value = this.registry.waiters.get(key);
    if (value === undefined) {
      return;
    }
    try {
      if (!Array.isArray(value)) {
        this.registry.waiters.delete(key);
        return;
      }
      const length = Reflect.get(value, "length");
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_WAITERS_PER_KEY
      ) {
        this.registry.waiters.delete(key);
        return;
      }
      const snapshot = new Array<Waiter>(length);
      for (let index = 0; index < length; index += 1) {
        snapshot[index] = Reflect.get(value, index);
      }
      this.registry.waiters.set(key, snapshot);
      return snapshot;
    } catch {
      this.registry.waiters.delete(key);
      return;
    }
  }

  private adaptiveState(index: number): AdaptiveState {
    const key = this.key(index);
    const existing = this.registry.adaptiveStates.get(key);
    const normalized = normalizedAdaptiveState(existing);
    if (normalized !== undefined) {
      if (normalized !== existing) {
        this.registry.adaptiveStates.set(key, normalized);
      }
      return normalized;
    }
    if (existing !== undefined) {
      this.registry.adaptiveStates.delete(key);
    }
    const entry = this.entries[index];
    const config =
      typeof entry.adaptiveConcurrency === "object"
        ? entry.adaptiveConcurrency
        : {};
    const min = config.min ?? 1;
    const max = config.max ?? Math.max(entry.maxConcurrency ?? 1, 16);
    const state: AdaptiveState = {
      increaseAfterSuccesses: config.increaseAfterSuccesses ?? 10,
      limit: Math.min(
        max,
        Math.max(min, config.initial ?? entry.maxConcurrency ?? min)
      ),
      max,
      min,
      successes: 0,
    };
    this.registry.adaptiveStates.set(key, state);
    return state;
  }

  private registerSharedConfigurations(): void {
    for (const [index, entry] of this.entries.entries()) {
      if (entry.healthKey === undefined) {
        continue;
      }
      const key = this.key(index);
      const signature = this.configurationSignature(entry);
      const existing = this.registry.configurations.get(key);
      if (existing !== undefined && existing !== signature) {
        throw new Error(
          `ai-router: candidates sharing healthKey "${entry.healthKey}" must use identical concurrency settings`
        );
      }
      this.registry.configurations.set(key, signature);
    }
  }

  private configurationSignature(entry: AdmissionEntry): string {
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
}
