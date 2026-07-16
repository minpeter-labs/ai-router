import { CandidateHealthStore } from "./candidate-health-store";
import {
  compareTokens,
  DEFAULT_CREDENTIAL_MS,
  DEFAULT_TRANSIENT_MS,
  effectiveHealthRecord,
  failureAtOrAfterAttempt,
  MAX_COOLDOWN_MS,
  newestToken,
  successCanSupersede,
  successSupersedesFailure,
} from "./health-record";
import type { HealthTransition } from "./health-store";
import type {
  FailureClassification,
  RouterHealthRecord,
  RouterOrderingToken,
} from "./types";

export class CandidateHealthTransitions extends CandidateHealthStore {
  failure(
    index: number,
    classification: FailureClassification,
    healthKey?: string,
    family?: string,
    attemptStartedAt?: RouterOrderingToken
  ): HealthTransition {
    if (classification.scope === "request") {
      return "ignored-stale";
    }
    const key = this.failureKey(index, classification, healthKey, family);
    this.knownKeys.add(key);
    const observedAt = this.clockNow();
    const orderingToken = attemptStartedAt ?? observedAt;
    const localPrevious = this.localWriteFailures.get(key);
    let attemptedRecord: RouterHealthRecord | undefined;
    const transition = this.update(
      key,
      (sharedPrevious) => {
        const previous = effectiveHealthRecord(sharedPrevious, localPrevious);
        if (successSupersedesFailure(previous?.lastSuccessAt, orderingToken)) {
          return { result: "ignored-stale" as const };
        }
        if (
          previous?.lastFailureAt !== undefined &&
          previous.cooldownUntil <= observedAt &&
          compareTokens(previous.lastFailureAt, orderingToken) >= 0
        ) {
          return { result: "ignored-stale" as const };
        }
        const requestedCooldown = Math.min(
          Math.max(
            classification.retryAfterMs ?? 0,
            classification.cooldownMs ?? 0
          ),
          MAX_COOLDOWN_MS
        );
        if (previous !== undefined && previous.cooldownUntil > observedAt) {
          const incomingIsNewest =
            compareTokens(orderingToken, previous.lastFailureAt) >= 0;
          attemptedRecord = {
            ...previous,
            cooldownUntil: Math.max(
              previous.cooldownUntil,
              observedAt + requestedCooldown
            ),
            lastFailureAt: newestToken(previous.lastFailureAt, orderingToken),
            ...(classification.statusCode === undefined || !incomingIsNewest
              ? {}
              : { lastStatus: classification.statusCode }),
            observedAtMs: observedAt,
          };
          return {
            record: attemptedRecord,
            result: "deduplicated" as const,
          };
        }
        const failures = Math.min(
          (previous?.failures ?? 0) + 1,
          Number.MAX_SAFE_INTEGER
        );
        const base =
          classification.scope === "credential"
            ? DEFAULT_CREDENTIAL_MS
            : DEFAULT_TRANSIENT_MS;
        const exponential = Math.min(
          base * 2 ** Math.min(failures - 1, 8),
          MAX_COOLDOWN_MS
        );
        const duration = Math.min(
          Math.max(exponential, requestedCooldown),
          MAX_COOLDOWN_MS
        );
        attemptedRecord = {
          cooldownUntil: observedAt + duration,
          failures,
          lastFailureAt: orderingToken,
          ...(classification.statusCode === undefined
            ? {}
            : { lastStatus: classification.statusCode }),
          observedAtMs: observedAt,
        };
        return {
          record: attemptedRecord,
          result: "cooling" as const,
        };
      },
      observedAt
    );
    if (transition === "cas-exhausted" && attemptedRecord !== undefined) {
      this.setLocalWriteFailure(key, attemptedRecord, observedAt);
    } else if (
      transition !== "cas-exhausted" &&
      transition !== "ignored-stale"
    ) {
      this.deleteLocalWriteFailure(key);
    }
    return transition;
  }

  success(
    index: number,
    healthKey?: string,
    family?: string,
    attemptStartedAt?: RouterOrderingToken
  ): HealthTransition | undefined {
    let transition: HealthTransition | undefined;
    const observedAt = this.clockNow();
    const orderingToken = attemptStartedAt ?? observedAt;
    for (const key of this.keys(index, healthKey, family)) {
      const localFailure = this.localWriteFailures.get(key);
      let attemptedRecord: RouterHealthRecord | undefined;
      const result = this.update(
        key,
        (previous) => {
          const newestFailure = newestToken(
            localFailure?.lastFailureAt,
            previous?.lastFailureAt ?? orderingToken
          );
          if (
            (localFailure?.lastFailureAt !== undefined ||
              previous?.lastFailureAt !== undefined) &&
            !successCanSupersede(newestFailure, orderingToken)
          ) {
            return { result: { recovered: false, written: false } };
          }
          attemptedRecord = {
            cooldownUntil: 0,
            failures: 0,
            lastSuccessAt: orderingToken,
            observedAtMs: observedAt,
          };
          return {
            record: attemptedRecord,
            result: {
              recovered:
                (previous !== undefined &&
                  (previous.failures > 0 ||
                    previous.probingUntil !== undefined)) ||
                (localFailure !== undefined && localFailure.failures > 0),
              written: true,
            },
          };
        },
        observedAt
      );
      if (result === "cas-exhausted") {
        if (attemptedRecord !== undefined) {
          this.setLocalWriteFailure(key, attemptedRecord, observedAt);
        }
        transition = "cas-exhausted";
      } else if (!result.written && transition !== "cas-exhausted") {
        transition = "ignored-stale";
      } else if (result.written) {
        this.deleteLocalWriteFailure(key);
        if (result.recovered && transition === undefined) {
          transition = "recovered";
        }
      }
    }
    return transition;
  }

  unavailableSince(
    index: number,
    selectedAt: RouterOrderingToken,
    healthKey?: string,
    family?: string
  ): boolean {
    const now = this.clockNow();
    return this.keys(index, healthKey, family).some((key) => {
      const local = this.localWriteFailures.get(key);
      if (
        local !== undefined &&
        local.cooldownUntil > now &&
        failureAtOrAfterAttempt(local.lastFailureAt, selectedAt)
      ) {
        return true;
      }
      const record = this.read(key, now);
      return (
        record !== undefined &&
        record.cooldownUntil > now &&
        failureAtOrAfterAttempt(record.lastFailureAt, selectedAt)
      );
    });
  }
}
