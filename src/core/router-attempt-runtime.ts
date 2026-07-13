import { RouterConcurrencyError } from "./admission-utils";
import {
  isTerminalRequestFailure,
  normalizeFailureClassification,
} from "./failure";
import {
  type HealthTransition,
  RouterHealthUnavailableError,
} from "./health-store";
import { runErrorObservabilityHook } from "./observability";
import { recordFailure, safeShouldRetry, surfaceFailure } from "./retry";
import { isSignalAborted } from "./router-options";
import type { ResolvedEntry } from "./stream";
import {
  effectiveTimeout,
  jitteredBackoff,
  monotonicNow,
  RouterTimeoutError,
} from "./timeout";
import type { FailureClassification } from "./types";

/**
 * A candidate entry normalized to a single internal shape, regardless of which
 * of the three accepted `ProviderEntry` forms the user wrote.
 */

import { RouterAttemptAdmission } from "./router-attempt-admission";

export class RouterAttemptRuntime extends RouterAttemptAdmission {
  protected handleFailure(
    error: unknown,
    candidate: ResolvedEntry,
    filteredIndex: number,
    candidates: ResolvedEntry[],
    errors: unknown[],
    phase: "generate" | "stream-open",
    classification: FailureClassification,
    attempt: number,
    attemptLimit: number,
    deadline: number | undefined,
    startedAt: number,
    healthTransition?: HealthTransition,
    inFlight?: number
  ): boolean {
    recordFailure(errors, error);
    const retry = classification.retryable;
    const hasNext =
      retry &&
      attempt < attemptLimit &&
      this.hasRetryCandidate(
        candidates,
        filteredIndex + 1,
        deadline,
        candidate.fullIndex
      );
    const errorPayload = {
      logicalId: this.modelId,
      entry: candidate.entry,
      index: candidate.fullIndex,
      error,
      phase,
      willRetry: hasNext,
    };
    runErrorObservabilityHook(errorPayload, (event) => this.onError?.(event));
    this.emitAttempt({
      candidate,
      attempt,
      durationMs: Math.max(0, monotonicNow() - startedAt),
      error,
      failure: classification,
      healthTransition,
      inFlight,
      outcome: "failure",
      phase,
      index: candidate.fullIndex,
      willRetry: hasNext,
    });
    return retry;
  }

  protected routeFailure(
    errors: unknown[],
    capacitySkips: number,
    healthSkips: number
  ): unknown {
    if (errors.length === 0 && capacitySkips > 0) {
      return new RouterConcurrencyError(this.modelId);
    }
    if (errors.length === 0 && healthSkips > 0) {
      return new RouterHealthUnavailableError(this.modelId);
    }
    return surfaceFailure(errors, this.modelId);
  }

  protected hasRetryCandidate(
    candidates: ResolvedEntry[],
    startIndex: number,
    deadline: number | undefined,
    releasingIndex?: number
  ): boolean {
    for (let index = startIndex; index < candidates.length; index++) {
      const candidate = candidates[index];
      const entry = this.normalized[candidate.fullIndex];
      if (
        this.healthEnabled &&
        !this.health.available(
          candidate.fullIndex,
          entry.healthKey,
          entry.providerFamily
        )
      ) {
        continue;
      }
      if (
        releasingIndex === undefined
          ? this.admission.canAcquire(candidate.fullIndex)
          : this.admission.canAcquireAfterRelease(
              candidate.fullIndex,
              releasingIndex
            )
      ) {
        return true;
      }
      if (
        index === candidates.length - 1 &&
        this.concurrencyWaitTimeout !== undefined &&
        (deadline === undefined || monotonicNow() < deadline)
      ) {
        return true;
      }
    }
    return false;
  }

  protected classify(error: unknown): FailureClassification {
    if (isTerminalRequestFailure(error)) {
      return { retryable: false, scope: "request" };
    }
    try {
      const classification = normalizeFailureClassification(
        this.classifyFailure(error)
      );
      if (this.hasCustomClassifier || !this.hasCustomRetry) {
        return classification;
      }
      return {
        ...classification,
        retryable: safeShouldRetry(this.shouldRetry, error),
      };
    } catch {
      return { retryable: false, scope: "request" };
    }
  }

  protected classifyAttemptFailure(
    error: unknown,
    callerSignal: AbortSignal | undefined
  ): FailureClassification {
    // Abort reasons are allowed to be arbitrary JavaScript values. When the
    // provider ignores the signal, withTimeout races it and preserves that
    // exact reason; classifying the reason alone would mistake an Error or
    // string for a transient provider outage.
    if (isSignalAborted(callerSignal)) {
      return { retryable: false, scope: "request" };
    }
    return this.classify(error);
  }

  protected shouldSurfaceDirectly(
    classification: FailureClassification
  ): boolean {
    return (
      !classification.retryable &&
      classification.scope === "request" &&
      classification.statusCode === undefined
    );
  }

  protected attemptTiming(deadline: number | undefined): {
    code: "attempt_timeout" | "total_timeout";
    timeoutMs: number | undefined;
  } {
    const remaining =
      deadline === undefined ? undefined : deadline - monotonicNow();
    if (remaining !== undefined && remaining <= 0) {
      throw new RouterTimeoutError("total_timeout", this.totalTimeout ?? 0);
    }
    const timeoutMs = effectiveTimeout(this.attemptTimeout, remaining);
    return {
      code:
        remaining !== undefined && timeoutMs === remaining
          ? "total_timeout"
          : "attempt_timeout",
      timeoutMs,
    };
  }

  protected timeoutDiagnosticDuration(
    code: "attempt_timeout" | "total_timeout"
  ): number | undefined {
    return code === "total_timeout" ? this.totalTimeout : this.attemptTimeout;
  }

  protected backoffAfterAttempt(
    attempts: number,
    signal: AbortSignal | undefined,
    deadline: number | undefined
  ): Promise<void> {
    if (attempts === 0) {
      return Promise.resolve();
    }
    const remaining =
      deadline === undefined ? undefined : deadline - monotonicNow();
    if (remaining !== undefined && remaining <= 0) {
      return Promise.reject(
        new RouterTimeoutError("total_timeout", this.totalTimeout ?? 0)
      );
    }
    const maximum =
      remaining === undefined || this.backoff === undefined
        ? this.backoff
        : Math.min(this.backoff, remaining);
    return jitteredBackoff(maximum, signal);
  }

  protected async backoffCandidate(
    candidate: ResolvedEntry,
    attempts: number,
    signal: AbortSignal | undefined,
    deadline: number | undefined
  ): Promise<void> {
    try {
      await this.backoffAfterAttempt(attempts, signal, deadline);
    } catch (error) {
      this.releaseCandidateProbe(candidate);
      throw error;
    }
  }
}
