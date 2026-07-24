import { consumeGenuinePromise, requireGenuinePromise } from "./runtime-types";
import {
  runIsolatedCandidateCleanup,
  runProbeCandidateCleanup,
} from "./stream-candidate-cleanup";
import {
  invokeReadOnlyCandidateHook,
  requireOptionalBooleanHookResult,
  snapshotCandidateForStateHook,
} from "./stream-candidate-hooks";
import {
  consumeCandidateSnapshotPromiseMutations,
  ownCandidateField,
  snapshotCandidateProbeLease,
} from "./stream-candidate-snapshot";
import { FallbackPumpState } from "./stream-pump-state";
import type { ResolvedEntry } from "./stream-types";
import { jitteredBackoff, monotonicNow, RouterTimeoutError } from "./timeout";

export abstract class FallbackPumpAdmission extends FallbackPumpState {
  protected abstract discardDeferredConcurrencySkip(idx: number): void;

  protected abstract emitSkippedAttempt(
    idx: number,
    reason: "concurrency" | "cooldown"
  ): void;

  protected async admitNext(
    retry: boolean,
    withinAttemptBudget: boolean,
    nextIndex: number
  ): Promise<{
    acquired?: { index: number; inFlight?: number };
    error?: unknown;
  }> {
    if (
      !(retry && withinAttemptBudget) ||
      nextIndex >= this.candidates.length ||
      this.cancelled
    ) {
      return {};
    }
    try {
      await this.backoffBeforeAdmission();
      return { acquired: await this.acquireNext(nextIndex) };
    } catch (error) {
      return { error };
    }
  }

  protected backoffBeforeAdmission(): Promise<void> {
    const remaining =
      this.config.totalDeadline === undefined
        ? undefined
        : this.config.totalDeadline - monotonicNow();
    if (remaining !== undefined && remaining <= 0) {
      return Promise.reject(
        new RouterTimeoutError("total_timeout", this.config.totalTimeout ?? 0)
      );
    }
    const maximum =
      remaining === undefined || this.config.backoff === undefined
        ? this.config.backoff
        : Math.min(this.config.backoff, remaining);
    return jitteredBackoff(maximum, this.operationAbort.signal);
  }

  protected nextAvailableIndex(startIndex: number): number {
    let index = startIndex;
    while (
      index < this.candidates.length &&
      !requireOptionalBooleanHookResult(
        invokeReadOnlyCandidateHook(
          this.candidateAvailable,
          this.candidates[index]
        ),
        "candidateAvailable"
      )
    ) {
      this.emitSkippedAttempt(index, "cooldown");
      index += 1;
    }
    return index;
  }

  protected prepareCandidateBeforeAdmission(candidate: ResolvedEntry): boolean {
    try {
      const prepared = requireOptionalBooleanHookResult(
        this.invokePrepareCandidate(candidate),
        "prepareCandidate"
      );
      if (!prepared) {
        runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      }
      return prepared;
    } catch (error) {
      runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      throw error;
    }
  }

  protected prepareOwnedCandidate(candidate: ResolvedEntry): boolean {
    try {
      const prepared = requireOptionalBooleanHookResult(
        this.invokePrepareCandidate(candidate),
        "prepareCandidate"
      );
      if (!prepared) {
        runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      }
      return prepared;
    } catch (error) {
      runIsolatedCandidateCleanup(this.releaseCandidate, candidate);
      runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      throw error;
    }
  }

  protected invokePrepareCandidate(candidate: ResolvedEntry): unknown {
    if (this.prepareCandidate === undefined) {
      return;
    }
    const hookCandidate = snapshotCandidateForStateHook(candidate);
    let didThrow = false;
    let thrown: unknown;
    let result: unknown;
    try {
      result = this.prepareCandidate(hookCandidate);
    } catch (error) {
      didThrow = true;
      thrown = error;
    }
    consumeCandidateSnapshotPromiseMutations(hookCandidate);
    try {
      candidate.probeLease = snapshotCandidateProbeLease(
        ownCandidateField(hookCandidate, "probeLease"),
        candidate.fullIndex
      );
    } catch (error) {
      if (!didThrow) {
        didThrow = true;
        thrown = error;
      }
    }
    if (didThrow) {
      throw thrown;
    }
    return result;
  }

  protected acquirePreparedCandidate(
    candidate: ResolvedEntry
  ): number | undefined {
    try {
      const inFlight = invokeReadOnlyCandidateHook(
        this.acquireCandidate,
        candidate
      );
      if (consumeGenuinePromise(inFlight)) {
        throw new TypeError(
          "ai-router: admission acquire hook must return synchronously"
        );
      }
      if (
        inFlight !== undefined &&
        (!Number.isSafeInteger(inFlight) || inFlight < 1)
      ) {
        throw new Error(
          "ai-router: admission acquire hook must return a positive safe in-flight count or undefined"
        );
      }
      return inFlight;
    } catch (error) {
      runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      throw error;
    }
  }

  protected availableAfterAdmission(candidate: ResolvedEntry): boolean {
    try {
      return requireOptionalBooleanHookResult(
        invokeReadOnlyCandidateHook(this.candidateAvailable, candidate),
        "candidateAvailable"
      );
    } catch (error) {
      runIsolatedCandidateCleanup(this.releaseCandidate, candidate);
      runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      throw error;
    }
  }

  protected async acquireNext(
    startIndex: number
  ): Promise<{ index: number; inFlight?: number } | undefined> {
    if (this.acquireCandidate === undefined) {
      return { index: startIndex };
    }
    let lastCapacityIndex: number | undefined;
    for (let index = startIndex; index < this.candidates.length; index++) {
      if (
        !requireOptionalBooleanHookResult(
          invokeReadOnlyCandidateHook(
            this.candidateAvailable,
            this.candidates[index]
          ),
          "candidateAvailable"
        )
      ) {
        this.emitSkippedAttempt(index, "cooldown");
        continue;
      }
      if (!this.prepareCandidateBeforeAdmission(this.candidates[index])) {
        this.emitSkippedAttempt(index, "cooldown");
        continue;
      }
      const inFlight = this.acquirePreparedCandidate(this.candidates[index]);
      if (inFlight !== undefined) {
        if (!this.availableAfterAdmission(this.candidates[index])) {
          runIsolatedCandidateCleanup(
            this.releaseCandidate,
            this.candidates[index]
          );
          runProbeCandidateCleanup(
            this.releaseProbeCandidate,
            this.candidates[index]
          );
          this.emitSkippedAttempt(index, "cooldown");
          continue;
        }
        return { index, inFlight };
      }
      lastCapacityIndex = index;
      runProbeCandidateCleanup(
        this.releaseProbeCandidate,
        this.candidates[index]
      );
      this.emitSkippedAttempt(index, "concurrency");
    }
    if (
      this.waitForCandidate !== undefined &&
      lastCapacityIndex !== undefined
    ) {
      try {
        const acquired = await this.waitForCapacity(lastCapacityIndex);
        if (acquired !== undefined) {
          this.discardDeferredConcurrencySkip(lastCapacityIndex);
        }
        return acquired;
      } catch (error) {
        this.discardDeferredConcurrencySkip(lastCapacityIndex);
        throw error;
      }
    }
    return;
  }

  protected async waitForCapacity(
    index: number
  ): Promise<{ index: number; inFlight?: number } | undefined> {
    const candidate = this.candidates[index];
    this.waitingIndex = index;
    let inFlight: number | undefined;
    try {
      const pending = invokeReadOnlyCandidateHook(
        this.waitForCandidate,
        candidate,
        this.operationAbort.signal
      );
      inFlight = await requireGenuinePromise<number | undefined>(
        pending,
        (error) =>
          new Error(
            "ai-router: admission wait hook must return a genuine Promise",
            { cause: error }
          )
      );
    } finally {
      this.waitingIndex = undefined;
    }
    if (inFlight === undefined) {
      this.assertWaitDeadline();
      return;
    }
    if (!Number.isSafeInteger(inFlight) || inFlight < 1) {
      throw new Error(
        "ai-router: admission wait hook must resolve to a positive safe in-flight count or undefined"
      );
    }
    if (!this.prepareOwnedCandidate(candidate)) {
      runIsolatedCandidateCleanup(this.releaseCandidate, candidate);
      this.emitSkippedAttempt(index, "cooldown");
      return;
    }
    if (!this.availableAfterAdmission(candidate)) {
      runIsolatedCandidateCleanup(this.releaseCandidate, candidate);
      runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      this.emitSkippedAttempt(index, "cooldown");
      return;
    }
    return { index, inFlight };
  }

  protected assertWaitDeadline(): void {
    if (
      this.config.totalDeadline !== undefined &&
      monotonicNow() >= this.config.totalDeadline
    ) {
      throw new RouterTimeoutError(
        "total_timeout",
        this.config.totalTimeout ?? 0
      );
    }
  }
}
