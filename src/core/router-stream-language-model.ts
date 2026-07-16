import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { cloneCallOptions, cloneInitialCallOptions } from "./call-options";
import { throwIfAborted } from "./router-options";
import { discardLateStreamResult, wrapStreamResult } from "./stream";
import { monotonicNow } from "./timeout";
import { withTimeout } from "./timeout-operation";

/**
 * A candidate entry normalized to a single internal shape, regardless of which
 * of the three accepted `ProviderEntry` forms the user wrote.
 */

import { RouterAttemptRuntime } from "./router-attempt-runtime";

export class RouterStreamLanguageModel extends RouterAttemptRuntime {
  async doStream(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4StreamResult> {
    const requestOptions = cloneInitialCallOptions(options);
    throwIfAborted(requestOptions.abortSignal);
    const selectedAt = this.nextOrderingToken();
    const { candidates, startIndex } = this.selectCandidates(
      requestOptions,
      "stream-open"
    );
    this.assertHasCandidate(candidates);

    const onAdvance = this.cooldown
      ? (filteredIndex: number, hadFailure: boolean) =>
          this.commitSurvivor(candidates[filteredIndex].fullIndex, hadFailure)
      : undefined;

    const errors: unknown[] = [];
    const deadline =
      this.totalTimeout === undefined
        ? undefined
        : monotonicNow() + this.totalTimeout;
    let attempts = 0;
    let capacitySkips = 0;
    let healthSkips = 0;
    let budgetFailureObserved = false;
    let budgetSuppressed = false;
    let directRequestError: unknown;
    const requestMaxAttempts =
      this.retryBudget?.available() === false ? 1 : this.maxAttempts;
    for (let k = startIndex; k < candidates.length; k++) {
      if (attempts >= requestMaxAttempts) {
        this.emitSkipped(candidates.slice(k), "stream-open", "max-attempts");
        break;
      }
      const candidate = candidates[k];
      await this.backoffCandidate(
        candidate,
        attempts,
        requestOptions.abortSignal,
        deadline
      );
      if (this.becameUnavailable(candidate.fullIndex, selectedAt)) {
        healthSkips += 1;
        this.releaseCandidateProbe(candidate);
        this.emitSkipped([candidate], "stream-open", "cooldown");
        continue;
      }
      const admission = await this.admitCandidate(
        candidate,
        k === candidates.length - 1,
        requestOptions.abortSignal,
        deadline,
        selectedAt,
        "stream-open"
      );
      capacitySkips += Number(admission.capacitySkipped);
      healthSkips += Number(admission.healthSkipped);
      if (admission.inFlight === undefined) {
        continue;
      }
      const inFlight = admission.inFlight;
      const startedAt = monotonicNow();
      const attemptOrderingToken = this.nextOrderingToken();
      attempts += 1;
      let result: LanguageModelV4StreamResult;
      try {
        // Errors thrown BEFORE the stream opens are caught here; errors that
        // arrive AFTER it opens are handled inside wrapStreamResult.
        const timing = this.attemptTiming(deadline);
        result = await withTimeout(
          (signal) =>
            candidate.model.doStream(cloneCallOptions(requestOptions, signal)),
          timing.timeoutMs,
          requestOptions.abortSignal,
          timing.code,
          this.timeoutDiagnosticDuration(timing.code),
          discardLateStreamResult
        );
      } catch (error) {
        const classification = this.classifyAttemptFailure(
          error,
          requestOptions.abortSignal
        );
        if (this.shouldSurfaceDirectly(classification)) {
          directRequestError = error;
        }
        this.admission.observe(
          candidate.fullIndex,
          false,
          classification,
          startedAt,
          attemptOrderingToken
        );
        budgetFailureObserved ||= this.isBudgetFailure(classification);
        budgetSuppressed ||= this.suppressesBudget(classification);
        const healthTransition = this.markFailureIfEnabled(
          candidate.fullIndex,
          classification,
          attemptOrderingToken
        );
        this.releaseCandidateProbe(candidate);
        let shouldContinue: boolean;
        try {
          shouldContinue = this.handleFailure(
            error,
            candidate,
            k,
            candidates,
            errors,
            "stream-open",
            classification,
            attempts,
            requestMaxAttempts,
            deadline,
            startedAt,
            healthTransition,
            inFlight
          );
        } finally {
          this.admission.release(candidate.fullIndex);
        }
        if (!shouldContinue) {
          break;
        }
        continue;
      }
      return wrapStreamResult({
        logicalId: this.modelId,
        candidates,
        startIndex: k,
        options: requestOptions,
        prepareCandidate: (entry) => this.prepareCandidate(entry),
        firstResult: result,
        shouldRetry: () => true,
        strictStreamValidation: this.strictStreamValidation,
        classifyFailure: (error) => this.classify(error),
        concurrencyLimit: (entry) => this.admission.limit(entry.fullIndex),
        candidateInFlight: (entry) => this.admission.inFlight(entry.fullIndex),
        attemptTimeout: this.attemptTimeout,
        backoff: this.backoff,
        retryAfterOutput: this.retryAfterOutput,
        firstContentTimeout: this.firstContentTimeout,
        maxAttempts: requestMaxAttempts,
        totalDeadline: deadline,
        totalTimeout: this.totalTimeout,
        attemptsStarted: attempts,
        startAttemptStartedAt: startedAt,
        startInFlight: inFlight,
        startOrderingToken: attemptOrderingToken,
        nextOrderingToken: () => this.nextOrderingToken(),
        candidateAvailable: (entry) =>
          !this.becameUnavailable(entry.fullIndex, selectedAt),
        acquireCandidate: (entry) => this.admission.acquire(entry.fullIndex),
        waitForCandidate: (entry, signal) =>
          this.admission.waitFor(
            entry.fullIndex,
            signal ?? requestOptions.abortSignal,
            deadline
          ),
        releaseCandidate: (entry) => this.admission.release(entry.fullIndex),
        releaseProbeCandidate: (entry) => this.releaseCandidateProbe(entry),
        budgetFailureObserved,
        budgetSuppressed,
        isBudgetFailure: (failure) => this.isBudgetFailure(failure),
        onRequestOutcome: (success, eligibleFailure, suppressed) => {
          if (success) {
            this.retryBudget?.observe(true);
          } else {
            this.observeRequestFailure(eligibleFailure, suppressed);
          }
        },
        onError: this.onError,
        onAttempt: this.onAttempt,
        onCandidateFailure: (
          entry,
          failure,
          attemptStartedAt,
          attemptStartedMonotonic
        ) => {
          this.admission.observe(
            entry.fullIndex,
            false,
            failure,
            attemptStartedMonotonic,
            attemptStartedAt
          );
          return this.markFailureIfEnabled(
            entry.fullIndex,
            failure,
            attemptStartedAt
          );
        },
        onCandidateSuccess: (
          entry,
          attemptStartedAt,
          attemptStartedMonotonic
        ) => {
          this.admission.observe(
            entry.fullIndex,
            true,
            undefined,
            attemptStartedMonotonic,
            attemptStartedAt
          );
          return this.markSuccessIfEnabled(entry.fullIndex, attemptStartedAt);
        },
        onAdvance,
        priorErrors: errors,
      });
    }
    this.observeRequestFailure(budgetFailureObserved, budgetSuppressed);
    if (directRequestError !== undefined) {
      throw directRequestError;
    }
    throw this.routeFailure(errors, capacitySkips, healthSkips);
  }

  /**
   * Record the error, classify it, notify `onError`, and report whether the
   * router should keep trying the next candidate (`true`) or stop (`false`).
   */
}
