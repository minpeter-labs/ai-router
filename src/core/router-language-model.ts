import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { cloneCallOptions, cloneInitialCallOptions } from "./call-options";
import { discardLateGenerateResult } from "./router-generate-envelope";
import { throwIfAborted } from "./router-options";
import { monotonicNow } from "./timeout";
import { withTimeout } from "./timeout-operation";

/**
 * A candidate entry normalized to a single internal shape, regardless of which
 * of the three accepted `ProviderEntry` forms the user wrote.
 */

import { RouterStreamLanguageModel } from "./router-stream-language-model";

export class RouterLanguageModel extends RouterStreamLanguageModel {
  async doGenerate(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4GenerateResult> {
    const requestOptions = cloneInitialCallOptions(options);
    throwIfAborted(requestOptions.abortSignal);
    const selectedAt = this.nextOrderingToken();
    const { candidates, startIndex } = this.selectCandidates(
      requestOptions,
      "generate"
    );
    this.assertHasCandidate(candidates);

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
        this.emitSkipped(candidates.slice(k), "generate", "max-attempts");
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
        this.emitSkipped([candidate], "generate", "cooldown");
        continue;
      }
      const admission = await this.admitCandidate(
        candidate,
        k === candidates.length - 1,
        requestOptions.abortSignal,
        deadline,
        selectedAt,
        "generate"
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
      try {
        const timing = this.attemptTiming(deadline);
        const result = await withTimeout(
          (signal) =>
            candidate.model.doGenerate(
              cloneCallOptions(requestOptions, signal)
            ),
          timing.timeoutMs,
          requestOptions.abortSignal,
          timing.code,
          this.timeoutDiagnosticDuration(timing.code),
          discardLateGenerateResult
        );
        const validatedResult = this.assertValidResult(result);
        const healthTransition = this.markSuccessIfEnabled(
          candidate.fullIndex,
          attemptOrderingToken
        );
        this.admission.observe(
          candidate.fullIndex,
          true,
          undefined,
          startedAt,
          attemptOrderingToken
        );
        this.retryBudget?.observe(true);
        this.commitSurvivor(candidate.fullIndex, errors.length > 0);
        this.emitAttempt({
          candidate,
          attempt: attempts,
          durationMs: Math.max(0, monotonicNow() - startedAt),
          outcome: "success",
          phase: "generate",
          index: candidate.fullIndex,
          inFlight,
          healthTransition,
        });
        return validatedResult;
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
        if (
          !this.handleFailure(
            error,
            candidate,
            k,
            candidates,
            errors,
            "generate",
            classification,
            attempts,
            requestMaxAttempts,
            deadline,
            startedAt,
            healthTransition,
            inFlight
          )
        ) {
          break;
        }
      } finally {
        this.releaseCandidateOwnership(candidate);
      }
    }
    this.observeRequestFailure(budgetFailureObserved, budgetSuppressed);
    if (directRequestError !== undefined) {
      throw directRequestError;
    }
    throw this.routeFailure(errors, capacitySkips, healthSkips);
  }
}
