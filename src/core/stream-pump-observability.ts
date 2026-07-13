import {
  isTerminalRequestFailure,
  normalizeFailureClassification,
} from "./failure";
import type { HealthTransition } from "./health-store";
import { runAttemptObservabilityHook } from "./observability";
import { safeShouldRetry } from "./retry";
import {
  runIsolatedCandidateCleanup,
  runProbeCandidateCleanup,
} from "./stream-candidate-cleanup";
import { optionalMetricHookValue } from "./stream-candidate-hooks";
/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */
import { streamSignalAborted } from "./stream-part-fields";
import { FallbackPumpAdmission } from "./stream-pump-admission";
import { monotonicNow } from "./timeout";
import type { FailureClassification, OnRouterAttempt } from "./types";

export abstract class FallbackPumpObservability extends FallbackPumpAdmission {
  protected classifyError(error: unknown): FailureClassification {
    if (
      streamSignalAborted(this.config.options.abortSignal) ||
      (this.classifyFailure === undefined && isTerminalRequestFailure(error))
    ) {
      return { retryable: false, scope: "request" };
    }
    try {
      return normalizeFailureClassification(
        this.classifyFailure === undefined
          ? {
              retryable: safeShouldRetry(this.shouldRetry, error),
              scope: "transient" as const,
            }
          : this.classifyFailure(error)
      );
    } catch {
      return { retryable: false, scope: "request" };
    }
  }

  protected emitAttempt(
    idx: number,
    outcome: "success" | "failure" | "cancelled",
    error?: unknown,
    failure?: FailureClassification,
    willRetry?: boolean,
    healthTransition?: HealthTransition,
    inFlight: number | undefined = this.activeInFlight
  ): void {
    const payload = {
      attempt: this.attemptsStarted,
      durationMs: Math.max(0, monotonicNow() - this.attemptStartedAt),
      entry: this.candidates[idx].entry,
      ...(error === undefined ? {} : { error }),
      ...(failure === undefined ? {} : { failure: { ...failure } }),
      ...(healthTransition === undefined ? {} : { healthTransition }),
      index: this.candidates[idx].fullIndex,
      inFlight,
      concurrencyLimit: optionalMetricHookValue(
        this.concurrencyLimit,
        this.candidates[idx]
      ),
      logicalId: this.config.logicalId,
      outcome,
      phase: this.committed
        ? ("stream-mid" as const)
        : ("stream-open" as const),
      ...(willRetry === undefined ? {} : { willRetry }),
    };
    runAttemptObservabilityHook(payload, (event) => this.onAttempt?.(event));
  }

  protected emitSkippedAttempt(
    idx: number,
    reason: "concurrency" | "cooldown"
  ): void {
    const payload = {
      durationMs: 0,
      entry: this.candidates[idx].entry,
      index: this.candidates[idx].fullIndex,
      concurrencyLimit: optionalMetricHookValue(
        this.concurrencyLimit,
        this.candidates[idx]
      ),
      ...(reason === "concurrency"
        ? {
            inFlight: optionalMetricHookValue(
              this.candidateInFlight,
              this.candidates[idx]
            ),
          }
        : {}),
      logicalId: this.config.logicalId,
      outcome: "skipped" as const,
      phase: this.committed
        ? ("stream-mid" as const)
        : ("stream-open" as const),
      reason,
    };
    this.emitOrDeferSkippedAttempt(payload);
  }

  protected releaseActiveCandidate(): void {
    if (this.activeIndex === undefined) {
      return;
    }
    const candidate = this.candidates[this.activeIndex];
    this.activeIndex = undefined;
    this.activeInFlight = undefined;
    runIsolatedCandidateCleanup(this.releaseCandidate, candidate);
    runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
  }

  protected emitMaxAttemptSkips(startIndex: number): void {
    for (let idx = startIndex; idx < this.candidates.length; idx++) {
      const payload = {
        durationMs: 0,
        entry: this.candidates[idx].entry,
        index: this.candidates[idx].fullIndex,
        concurrencyLimit: optionalMetricHookValue(
          this.concurrencyLimit,
          this.candidates[idx]
        ),
        logicalId: this.config.logicalId,
        outcome: "skipped" as const,
        phase: this.committed
          ? ("stream-mid" as const)
          : ("stream-open" as const),
        reason: "max-attempts" as const,
      };
      this.emitOrDeferSkippedAttempt(payload);
    }
  }

  protected emitOrDeferSkippedAttempt(
    payload: Parameters<OnRouterAttempt>[0]
  ): void {
    if (this.deferSkippedAttemptEvents) {
      this.deferredSkippedAttemptEvents.push(payload);
      return;
    }
    runAttemptObservabilityHook(payload, (event) => this.onAttempt?.(event));
  }

  protected flushDeferredSkippedAttemptEvents(): void {
    for (const payload of this.deferredSkippedAttemptEvents) {
      runAttemptObservabilityHook(payload, (event) => this.onAttempt?.(event));
    }
    this.deferredSkippedAttemptEvents.length = 0;
  }

  protected discardDeferredConcurrencySkip(idx: number): void {
    const index = this.candidates[idx].fullIndex;
    for (
      let position = this.deferredSkippedAttemptEvents.length - 1;
      position >= 0;
      position--
    ) {
      const payload = this.deferredSkippedAttemptEvents[position];
      if (
        payload.index === index &&
        payload.outcome === "skipped" &&
        payload.reason === "concurrency"
      ) {
        this.deferredSkippedAttemptEvents.splice(position, 1);
        return;
      }
    }
  }

  protected emitCancelledPendingAttempt(): void {
    const idx = this.cancelledPendingIndex;
    this.cancelledPendingIndex = undefined;
    if (idx === undefined) {
      return;
    }
    const payload = {
      durationMs: 0,
      entry: this.candidates[idx].entry,
      index: this.candidates[idx].fullIndex,
      concurrencyLimit: optionalMetricHookValue(
        this.concurrencyLimit,
        this.candidates[idx]
      ),
      inFlight: optionalMetricHookValue(
        this.candidateInFlight,
        this.candidates[idx]
      ),
      logicalId: this.config.logicalId,
      outcome: "cancelled" as const,
      phase: this.committed
        ? ("stream-mid" as const)
        : ("stream-open" as const),
    };
    runAttemptObservabilityHook(payload, (event) => this.onAttempt?.(event));
  }

  protected beginDeferredAdmission(
    retry: boolean,
    withinAttemptBudget: boolean,
    nextIdx: number
  ): void {
    this.deferSkippedAttemptEvents = true;
    this.pendingFallbackIndex =
      retry && withinAttemptBudget && nextIdx < this.candidates.length
        ? nextIdx
        : undefined;
  }

  protected endDeferredAdmission(): void {
    this.deferSkippedAttemptEvents = false;
    this.pendingFallbackIndex = undefined;
  }

  // Buffer framing pre-commit, else commit + forward. Returns whether this
  // candidate has been committed to cooldown yet.
}
