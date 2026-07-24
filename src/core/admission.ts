import { AdmissionCapacity } from "./admission-capacity";
import {
  type AdmissionSnapshot,
  isCongestionFailure,
  MAX_ROUND_ROBIN_POOL_KEY_CHARS,
  MAX_ROUND_ROBIN_POOLS,
  retainAdaptiveOutcomeOrder,
  roundRobinPoolKey,
  staleAdaptiveOutcome,
} from "./admission-utils";
import type { FailureClassification, RouterOrderingToken } from "./types";

export class AdmissionController extends AdmissionCapacity {
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
}
