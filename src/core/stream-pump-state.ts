import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { HealthTransition } from "./health-store";
import { runErrorObservabilityHook } from "./observability";
import { consumeGenuinePromise } from "./runtime-types";
import {
  invokeReadOnlyCandidateHook,
  isValidOrderingToken,
} from "./stream-candidate-hooks";
import {
  consumeFailureClassificationPromiseMutations,
  validHealthTransitionHookResult,
} from "./stream-candidate-snapshot";
/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */
import {
  fallbackOrderingTokens,
  streamCancelReason,
  streamSignalAborted,
} from "./stream-part-fields";
import { FallbackPumpContext } from "./stream-pump-context";
import { cancelAndReleaseReaderQuietly, cancelQuietly } from "./stream-reader";
import { abortControllerSafely } from "./timeout";
import type { FailureClassification, RouterOrderingToken } from "./types";

export abstract class FallbackPumpState extends FallbackPumpContext {
  run(): Promise<void> {
    return this.pump(this.config.firstResult, this.config.startIndex);
  }

  cancel(reason: unknown): void {
    const callerSignal = this.config.options.abortSignal;
    const callerAborted =
      this.callerAbortObserved || streamSignalAborted(callerSignal);
    const safeReason = callerAborted
      ? this.captureCallerAbortReason(callerSignal)
      : streamCancelReason(reason);
    this.cancelled = true;
    this.cancelReason = safeReason;
    abortControllerSafely(this.operationAbort, safeReason);
    this.cleanupAbortForwarding();
    const reader = this.activeReader;
    this.activeReader = null;
    cancelAndReleaseReaderQuietly(reader, safeReason);
    this.resume();
    if (!callerAborted) {
      if (this.activeIndex === undefined) {
        this.cancelledPendingIndex =
          this.waitingIndex ?? this.pendingFallbackIndex;
      } else {
        this.emitAttempt(this.activeIndex, "cancelled");
      }
    }
    this.releaseActiveCandidate();
  }

  resume(): void {
    const resume = this.resumeDemand;
    this.resumeDemand = undefined;
    resume?.();
  }

  failUnexpected(error: unknown): void {
    cancelQuietly(this.activeReader, error);
    this.releaseActiveCandidate();
    this.safeError(error);
    this.finishRequest(false);
    this.resume();
  }

  protected safeEnqueue(part: LanguageModelV4StreamPart): void {
    try {
      this.controller.enqueue(part);
    } catch {
      // Controller already closed/errored (e.g. after cancel).
    }
  }

  protected safeClose(): void {
    try {
      this.controller.close();
    } catch {
      // Already closed.
    }
  }

  protected safeError(error: unknown): void {
    try {
      this.controller.error(error);
    } catch {
      // Already closed/errored.
    }
  }

  protected flushPrelude(): void {
    for (const part of this.prelude) {
      this.safeEnqueue(part);
    }
    this.prelude = [];
    this.preludeMetadataNodes = 0;
    this.preludeTextChars = 0;
  }

  protected emitOnError(error: unknown, idx: number, willRetry: boolean): void {
    const payload = {
      logicalId: this.config.logicalId,
      entry: this.candidates[idx].entry,
      index: this.candidates[idx].fullIndex,
      error,
      phase: this.committed
        ? ("stream-mid" as const)
        : ("stream-open" as const),
      willRetry,
    };
    runErrorObservabilityHook(payload, (event) => this.onError?.(event));
  }

  protected recordCandidateFailure(
    idx: number,
    classification: FailureClassification
  ): HealthTransition | undefined {
    const hookClassification = { ...classification };
    try {
      const result = invokeReadOnlyCandidateHook(
        this.onCandidateFailure,
        this.candidates[idx],
        hookClassification,
        this.attemptOrderingToken,
        this.attemptStartedAt
      );
      return validHealthTransitionHookResult(result);
    } catch {
      return;
    } finally {
      consumeFailureClassificationPromiseMutations(hookClassification);
    }
  }

  protected recordCandidateSuccess(idx: number): HealthTransition | undefined {
    try {
      const result = invokeReadOnlyCandidateHook(
        this.onCandidateSuccess,
        this.candidates[idx],
        this.attemptOrderingToken,
        this.attemptStartedAt
      );
      return validHealthTransitionHookResult(result);
    } catch {
      return;
    }
  }

  protected nextAttemptOrderingToken(): RouterOrderingToken {
    try {
      const token = this.nextOrderingToken?.();
      if (consumeGenuinePromise(token)) {
        throw new TypeError(
          "ai-router: nextOrderingToken hook must return synchronously"
        );
      }
      if (isValidOrderingToken(token)) {
        return token;
      }
    } catch {
      // An optional token source cannot prevent a provider attempt.
    }
    return fallbackOrderingTokens.next();
  }
}
