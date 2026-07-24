import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { HealthTransition } from "./health-store";
import { runAttemptObservabilityHook } from "./observability";
import { snapshotGenerateEnvelope } from "./router-generate-envelope";
import {
  EmptyModelResponseError,
  InvalidModelResponseError,
  ValidatorContractError,
  validateGenerateEnvelope,
} from "./router-generate-validation";
import {
  captureValidatorMutationTargets,
  consumeCapturedValidatorMutationPromises,
  consumeNestedValidatorInputPromiseMutations,
  GENERATE_ENVELOPE_FIELDS,
  hasOutputContent,
} from "./router-generate-validator";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";
import type { ResolvedEntry } from "./stream";
import type {
  FailureClassification,
  OnRouterAttempt,
  RouterOrderingToken,
} from "./types";

/**
 * A candidate entry normalized to a single internal shape, regardless of which
 * of the three accepted `ProviderEntry` forms the user wrote.
 */

import { RouterModelState } from "./router-model-state";

export class RouterAttemptObservability extends RouterModelState {
  protected assertValidResult(
    result: LanguageModelV4GenerateResult
  ): LanguageModelV4GenerateResult {
    let snapshot: LanguageModelV4GenerateResult;
    try {
      snapshot = snapshotGenerateEnvelope(result);
    } catch {
      throw new InvalidModelResponseError(
        "result properties could not be read"
      );
    }
    const shapeError = validateGenerateEnvelope(snapshot);
    if (shapeError !== undefined) {
      throw new InvalidModelResponseError(shapeError);
    }
    snapshot = {
      ...snapshot,
      content: [...snapshot.content],
      warnings: [...snapshot.warnings],
    };
    if (!hasOutputContent(snapshot)) {
      throw new EmptyModelResponseError();
    }
    if (this.validateResult === undefined) {
      return snapshot;
    }
    const validatorInput = snapshotGenerateEnvelope(snapshot);
    const validatorMutationTargets =
      captureValidatorMutationTargets(validatorInput);
    let validation: unknown;
    try {
      validation = this.validateResult(validatorInput);
    } catch (error) {
      throw new ValidatorContractError("threw", error);
    } finally {
      consumeOwnDataPromiseFields(validatorInput, GENERATE_ENVELOPE_FIELDS);
      consumeNestedValidatorInputPromiseMutations(validatorInput);
      consumeCapturedValidatorMutationPromises(validatorMutationTargets);
    }
    if (
      ((typeof validation === "object" && validation !== null) ||
        typeof validation === "function") &&
      consumeGenuinePromise(validation)
    ) {
      throw new ValidatorContractError("must be synchronous");
    }
    if (validation === true) {
      return snapshot;
    }
    if (validation === false) {
      throw new InvalidModelResponseError("custom validator returned false");
    }
    if (typeof validation === "string") {
      throw new InvalidModelResponseError(validation);
    }
    throw new ValidatorContractError("must return boolean or string");
  }

  protected emitAttempt(
    info: Omit<Parameters<OnRouterAttempt>[0], "entry" | "logicalId"> & {
      candidate: ResolvedEntry;
    }
  ): void {
    const { candidate, failure, ...rest } = info;
    const payload = {
      ...rest,
      ...(failure === undefined ? {} : { failure: { ...failure } }),
      ...(rest.concurrencyLimit === undefined
        ? { concurrencyLimit: this.admission.limit(candidate.fullIndex) }
        : {}),
      entry: candidate.entry,
      logicalId: this.modelId,
    };
    runAttemptObservabilityHook(payload, (event) => this.onAttempt?.(event));
  }

  protected emitSkipped(
    candidates: ResolvedEntry[],
    phase: "generate" | "stream-open",
    reason: "concurrency" | "cooldown" | "max-attempts"
  ): void {
    for (const candidate of candidates) {
      this.emitAttempt({
        candidate,
        durationMs: 0,
        index: candidate.fullIndex,
        outcome: "skipped",
        phase,
        reason,
        concurrencyLimit: this.admission.limit(candidate.fullIndex),
        ...(reason === "concurrency"
          ? {
              inFlight: this.admission.inFlight(candidate.fullIndex),
            }
          : {}),
      });
    }
  }

  protected markFailure(
    index: number,
    classification: FailureClassification,
    attemptStartedAt: RouterOrderingToken = Date.now()
  ): HealthTransition {
    const entry = this.normalized[index];
    return this.health.failure(
      index,
      classification,
      entry.healthKey,
      entry.providerFamily,
      attemptStartedAt
    );
  }

  protected markFailureIfEnabled(
    index: number,
    classification: FailureClassification,
    attemptStartedAt: RouterOrderingToken = Date.now()
  ): HealthTransition | undefined {
    if (this.healthEnabled && classification.scope !== "request") {
      return this.markFailure(index, classification, attemptStartedAt);
    }
    return;
  }

  protected markSuccess(
    index: number,
    attemptStartedAt: RouterOrderingToken = Date.now()
  ): HealthTransition | undefined {
    const entry = this.normalized[index];
    return this.health.success(
      index,
      entry.healthKey,
      entry.providerFamily,
      attemptStartedAt
    );
  }

  protected markSuccessIfEnabled(
    index: number,
    attemptStartedAt: RouterOrderingToken = Date.now()
  ): HealthTransition | undefined {
    if (this.healthEnabled) {
      return this.markSuccess(index, attemptStartedAt);
    }
    return;
  }

  protected becameUnavailable(
    index: number,
    selectedAt: RouterOrderingToken
  ): boolean {
    if (!this.healthEnabled) {
      return false;
    }
    const entry = this.normalized[index];
    return this.health.unavailableSince(
      index,
      selectedAt,
      entry.healthKey,
      entry.providerFamily
    );
  }

  protected nextOrderingToken(): RouterOrderingToken {
    return this.ordering.next();
  }

  protected isBudgetFailure(failure: FailureClassification): boolean {
    return failure.retryable && failure.scope !== "request";
  }

  protected suppressesBudget(failure: FailureClassification): boolean {
    return !failure.retryable && failure.scope === "request";
  }

  protected observeRequestFailure(
    eligible: boolean,
    suppressed: boolean
  ): void {
    if (eligible && !suppressed) {
      this.retryBudget?.observe(false);
    }
  }
}
