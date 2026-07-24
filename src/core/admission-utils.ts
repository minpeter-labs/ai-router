import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";
import type {
  AdaptiveConcurrencyConfig,
  FailureClassification,
  RouterOrderingToken,
} from "./types";

export const MAX_ROUND_ROBIN_POOLS = 1024;
export const MAX_ROUND_ROBIN_POOL_KEY_CHARS = 1_048_576;
export const MAX_WAITERS_PER_KEY = 10_000;
export const ADMISSION_ORDERING_TOKEN_RE = /^v1:(\d+):([^:]+):(\d+)$/;

export function roundRobinPoolKey(
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

export interface AdaptiveState {
  increaseAfterSuccesses: number;
  lastOutcomeOrderingToken?: RouterOrderingToken;
  lastOutcomeStartedAt?: number;
  limit: number;
  max: number;
  min: number;
  successes: number;
}

export function normalizedAdaptiveState(
  value: unknown
): AdaptiveState | undefined {
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

export interface Waiter {
  acquire: () => number | undefined;
  resolve: (value: number | undefined) => void;
}

export function isValidWaiterSlot(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function isCongestionFailure(
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

export function staleAdaptiveOutcome(
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

export function compareAdaptiveOrderingTokens(
  left: string,
  right: string
): number {
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

export function retainAdaptiveOutcomeOrder(
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

export function abortReason(signal: AbortSignal | undefined): unknown {
  try {
    const reason = signal?.reason;
    return consumeGenuinePromise(reason)
      ? new DOMException("aborted", "AbortError")
      : (reason ?? new DOMException("aborted", "AbortError"));
  } catch {
    return new DOMException("aborted", "AbortError");
  }
}

export function isSignalAborted(signal: AbortSignal | undefined): boolean {
  try {
    const aborted = signal?.aborted;
    return !consumeGenuinePromise(aborted) && aborted === true;
  } catch {
    return false;
  }
}

export function captureUsableWaiter(value: unknown): Waiter | undefined {
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
