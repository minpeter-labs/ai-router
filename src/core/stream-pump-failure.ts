import type { LanguageModelV4StreamResult } from "@ai-sdk/provider";
import { cloneCallOptions } from "./call-options";
import { recordFailure, surfaceFailure } from "./retry";
import { discardLateStreamResult } from "./stream";
import {
  runIsolatedCandidateCleanup,
  runProbeCandidateCleanup,
} from "./stream-candidate-cleanup";
/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */
import { streamAbortReason, streamSignalAborted } from "./stream-part-fields";
import { FallbackPumpObservability } from "./stream-pump-observability";
import { cancelQuietly } from "./stream-reader";
import { effectiveTimeout, monotonicNow, RouterTimeoutError } from "./timeout";
import { withTimeout } from "./timeout-operation";
import type { FailureClassification } from "./types";

export abstract class FallbackPumpFailure extends FallbackPumpObservability {
  protected abstract observeFailureForBudget(
    failure: FailureClassification
  ): void;

  protected async onFailure(error: unknown, idx: number): Promise<void> {
    const failedInFlight = this.activeInFlight;
    if (this.terminateForCallerAbort()) {
      return;
    }
    // Once this candidate has failed, it must not keep producing an unread
    // body while a fallback is opening. This also releases provider-side
    // sockets and generation work promptly.
    cancelQuietly(this.activeReader, error);
    this.rollbackDiscardedCandidateBudget();
    // The failed candidate's buffered framing is dropped — it never streams.
    this.prelude = [];
    this.preludeMetadataNodes = 0;
    this.preludeTextChars = 0;
    recordFailure(this.errors, error);
    const classification = this.classifyError(error);
    this.observeFailureForBudget(classification);
    const healthTransition = this.recordCandidateFailure(idx, classification);
    this.releaseActiveCandidate();
    const blockedByOutput = this.committed && !this.config.retryAfterOutput;
    const retry = !blockedByOutput && classification.retryable;
    let nextIdx = this.nextAvailableIndex(idx + 1);
    const withinAttemptBudget =
      this.attemptsStarted <
      (this.config.maxAttempts ?? this.candidates.length);
    this.beginDeferredAdmission(retry, withinAttemptBudget, nextIdx);
    let admission: Awaited<ReturnType<FallbackPumpFailure["admitNext"]>>;
    try {
      this.emitMaxAttemptSkipsWhenNeeded(retry, nextIdx, withinAttemptBudget);
      admission = await this.admitNext(retry, withinAttemptBudget, nextIdx);
    } finally {
      this.endDeferredAdmission();
    }
    const { acquired, error: admissionError } = admission;
    const willRetry = acquired !== undefined;
    this.emitOnError(error, idx, willRetry);
    this.emitAttempt(
      idx,
      "failure",
      error,
      classification,
      willRetry,
      healthTransition,
      failedInFlight
    );
    this.flushDeferredSkippedAttemptEvents();
    this.emitCancelledPendingAttempt();

    if (blockedByOutput) {
      this.finishRequest(false);
      this.safeError(error);
      return;
    }
    if (admissionError !== undefined) {
      // Admission/backoff control failures terminate the request without
      // turning an earlier provider failure into a retry-budget sample. In
      // particular, a total deadline or caller abort while queued is censored
      // just like the same control error during provider opening.
      this.budgetSuppressed = true;
      this.finishRequest(false);
      this.safeError(admissionError);
      return;
    }
    if (!retry) {
      this.finishRequest(false);
      this.safeError(this.terminalFailure(error, classification));
      return;
    }
    if (!willRetry) {
      this.finishRequest(false);
      this.safeError(surfaceFailure(this.errors, this.config.logicalId));
      return;
    }
    if (this.cancelled) {
      const candidate = this.candidates[acquired.index];
      runIsolatedCandidateCleanup(this.releaseCandidate, candidate);
      runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      return;
    }

    let nextResult: LanguageModelV4StreamResult;
    nextIdx = acquired.index;
    this.activeIndex = nextIdx;
    this.activeInFlight = acquired.inFlight;
    try {
      this.attemptsStarted += 1;
      this.attemptStartedAt = monotonicNow();
      this.attemptOrderingToken = this.nextAttemptOrderingToken();
      const remaining =
        this.config.totalDeadline === undefined
          ? undefined
          : this.config.totalDeadline - monotonicNow();
      if (remaining !== undefined && remaining <= 0) {
        throw new RouterTimeoutError(
          "total_timeout",
          this.config.totalTimeout ?? 0
        );
      }
      const timeout = effectiveTimeout(this.config.attemptTimeout, remaining);
      nextResult = await withTimeout(
        (signal) =>
          this.candidates[nextIdx].model.doStream(
            cloneCallOptions(this.config.options, signal)
          ),
        timeout,
        this.operationAbort.signal,
        remaining !== undefined && timeout === remaining
          ? "total_timeout"
          : "attempt_timeout",
        remaining !== undefined && timeout === remaining
          ? this.config.totalTimeout
          : this.config.attemptTimeout,
        discardLateStreamResult
      );
    } catch (openErr) {
      return this.handleFallbackOpenFailure(openErr, nextIdx);
    }
    return this.pump(nextResult, nextIdx);
  }

  protected emitMaxAttemptSkipsWhenNeeded(
    retry: boolean,
    nextIndex: number,
    withinAttemptBudget: boolean
  ): void {
    if (retry && nextIndex < this.candidates.length && !withinAttemptBudget) {
      this.emitMaxAttemptSkips(nextIndex);
    }
  }

  protected terminateForCallerAbort(): boolean {
    const callerSignal = this.config.options.abortSignal;
    if (!streamSignalAborted(callerSignal)) {
      return false;
    }
    const reason = this.captureCallerAbortReason(callerSignal);
    cancelQuietly(this.activeReader, reason);
    this.rollbackDiscardedCandidateBudget();
    this.prelude = [];
    this.preludeMetadataNodes = 0;
    this.preludeTextChars = 0;
    this.budgetSuppressed = true;
    this.releaseActiveCandidate();
    this.finishRequest(false);
    this.safeError(reason);
    return true;
  }

  protected captureCallerAbortReason(signal: AbortSignal | undefined): unknown {
    if (!this.callerAbortObserved) {
      this.callerAbortObserved = true;
      this.callerAbortReason = streamAbortReason(signal);
    }
    return this.callerAbortReason;
  }

  protected rollbackDiscardedCandidateBudget(): void {
    if (!this.candidateCommitted) {
      Object.assign(this.streamJsonBudget, this.candidateBudgetCheckpoint);
    }
  }

  protected handleFallbackOpenFailure(
    error: unknown,
    index: number
  ): Promise<void> | undefined {
    return this.cancelled ? undefined : this.onFailure(error, index);
  }

  protected terminalFailure(
    error: unknown,
    classification: FailureClassification
  ): unknown {
    return classification.scope === "request" &&
      classification.statusCode === undefined
      ? error
      : surfaceFailure(this.errors, this.config.logicalId);
  }
}
