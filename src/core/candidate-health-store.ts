import { CandidateHealthStoreContext } from "./candidate-health-store-context";
import {
  consumeAsyncResult,
  HEALTH_CLOCK_SKEW_MS,
  HEALTH_STALE_AFTER_MS,
  invalidStoreMutationResult,
  MAX_COOLDOWN_MS,
  normalizedRecord,
  PROBE_LEASE_MS,
  stringTokenTooFarInFuture,
  validHealthNow,
} from "./health-record";
import { resolveCasResult } from "./health-store";
import { consumeGenuinePromise } from "./runtime-types";
import type { FailureClassification, RouterHealthRecord } from "./types";

export class CandidateHealthStore extends CandidateHealthStoreContext {
  protected claimLocalLease(
    key: string,
    current: RouterHealthRecord,
    now: number
  ): boolean {
    if (current.cooldownUntil > now || (current.probingUntil ?? 0) > now) {
      return false;
    }
    const probingUntil = now + PROBE_LEASE_MS;
    this.setLocalWriteFailure(key, { ...current, probingUntil }, now);
    this.claimedProbes.set(key, { key, probingUntil, source: "local" });
    return true;
  }

  protected claimLease(
    key: string,
    current: RouterHealthRecord,
    now = this.clockNow()
  ): boolean {
    if (current.version === Number.MAX_SAFE_INTEGER) {
      // The numeric CAS contract cannot represent another distinct version.
      // Coordinate a process-local probe without corrupting the shared record
      // with an unsafe integer.
      return this.claimLocalLease(key, current, now);
    }
    const next = {
      ...current,
      probingUntil: now + PROBE_LEASE_MS,
      version: (current.version ?? 0) + 1,
    };
    const compareAndSet = this.compareAndSet();
    if (compareAndSet !== undefined) {
      try {
        const claimed = compareAndSet(key, current.version, next);
        if (
          invalidStoreMutationResult(claimed) ||
          (claimed !== true && claimed !== false)
        ) {
          return this.claimLocalLease(key, current, now);
        }
        if (claimed === true) {
          this.claimedProbes.set(key, {
            key,
            probingUntil: next.probingUntil,
          });
        }
        // A malformed synchronous result cannot prove lease ownership. Keep
        // routing fail-open, but do not retain a lease that we cannot safely
        // release later.
        return claimed !== false;
      } catch {
        // Preserve fail-open routing while preventing a same-process probe
        // stampede when shared reads work but lease writes do not.
        return this.claimLocalLease(key, current, now);
      }
    }
    try {
      const result = this.store.set(key, next);
      if (invalidStoreMutationResult(result)) {
        return this.claimLocalLease(key, current, now);
      }
      this.claimedProbes.set(key, { key, probingUntil: next.probingUntil });
    } catch {
      return this.claimLocalLease(key, current, now);
    }
    return true;
  }

  protected pruneExpiredClaimedProbes(keys: string[], now: number): void {
    for (const key of keys) {
      const lease = this.claimedProbes.get(key);
      if (lease !== undefined && lease.probingUntil <= now) {
        this.claimedProbes.delete(key);
      }
    }
  }

  protected update<T>(
    key: string,
    updater: (current: RouterHealthRecord | undefined) => {
      record?: RouterHealthRecord;
      result: T;
    },
    decisionNow?: number
  ): T | "cas-exhausted" {
    const compareAndSet = this.compareAndSet();
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = this.readForDecision(key, decisionNow);
      const update = updater(current);
      if (update.record === undefined) {
        return update.result;
      }
      if (current?.version === Number.MAX_SAFE_INTEGER) {
        return "cas-exhausted";
      }
      const next = {
        ...update.record,
        version: (current?.version ?? 0) + 1,
      };
      if (compareAndSet === undefined) {
        try {
          const result = this.store.set(key, next);
          if (invalidStoreMutationResult(result)) {
            return "cas-exhausted";
          }
          return update.result;
        } catch {
          return "cas-exhausted";
        }
      }
      try {
        const result = compareAndSet(key, current?.version, next);
        if (invalidStoreMutationResult(result)) {
          return "cas-exhausted";
        }
        const outcome = resolveCasResult(result, update.result);
        if (outcome !== undefined) {
          return outcome;
        }
      } catch {
        return "cas-exhausted";
      }
    }
    return "cas-exhausted";
  }

  protected readForDecision(
    key: string,
    decisionNow: number | undefined
  ): RouterHealthRecord | undefined {
    return decisionNow === undefined
      ? this.read(key)
      : this.read(key, decisionNow);
  }

  protected compareAndSet():
    | ((
        key: string,
        expectedVersion: number | undefined,
        value: RouterHealthRecord
      ) => boolean)
    | undefined {
    try {
      const method = this.store.compareAndSet;
      return method === undefined ? undefined : method.bind(this.store);
    } catch {
      return;
    }
  }

  protected read(
    key: string,
    decisionNow = this.clockNow()
  ): RouterHealthRecord | undefined {
    let raw: unknown;
    try {
      raw = this.store.get(key);
      if (consumeAsyncResult(raw)) {
        return;
      }
    } catch {
      return;
    }
    const record = normalizedRecord(raw);
    if (record === undefined) {
      return;
    }
    const now = decisionNow;
    if (
      !Number.isFinite(now) ||
      (record.observedAtMs !== undefined &&
        record.observedAtMs > now + HEALTH_CLOCK_SKEW_MS) ||
      record.cooldownUntil > now + MAX_COOLDOWN_MS + HEALTH_CLOCK_SKEW_MS ||
      (record.probingUntil ?? 0) >
        now + PROBE_LEASE_MS + HEALTH_CLOCK_SKEW_MS ||
      stringTokenTooFarInFuture(record.lastFailureAt, now) ||
      stringTokenTooFarInFuture(record.lastSuccessAt, now)
    ) {
      // A malformed or badly skewed shared record must not permanently remove
      // a candidate from routing. Fail open; a later valid write can replace it.
      return;
    }
    if (
      record.observedAtMs !== undefined &&
      now - record.observedAtMs > HEALTH_STALE_AFTER_MS &&
      record.cooldownUntil <= now &&
      (record.probingUntil ?? 0) <= now
    ) {
      if (this.pruneStaleRecords) {
        try {
          consumeAsyncResult(this.store.delete(key));
        } catch {
          // Lazy cleanup is best-effort.
        }
      }
      return;
    }
    return record;
  }

  protected clockNow(): number {
    try {
      const value = this.now();
      if (consumeGenuinePromise(value)) {
        throw new Error("async health clock is unsupported");
      }
      if (validHealthNow(value)) {
        this.lastValidNow = value;
        return value;
      }
    } catch {
      // Freeze health time rather than letting an optional clock break routing.
    }
    if (this.lastValidNow !== undefined) {
      return this.lastValidNow;
    }
    try {
      const fallback = Date.now();
      if (consumeGenuinePromise(fallback)) {
        throw new Error("async fallback clock is unsupported");
      }
      if (validHealthNow(fallback)) {
        this.lastValidNow = fallback;
        return fallback;
      }
    } catch {
      // A fully unavailable clock still fails open at the Unix epoch.
    }
    this.lastValidNow = 0;
    return 0;
  }

  protected failureKey(
    index: number,
    classification: FailureClassification,
    healthKey?: string,
    family?: string
  ): string {
    if (classification.scope === "credential" && healthKey !== undefined) {
      return `${this.sharedNamespace}:credential:${healthKey}`;
    }
    if (classification.scope === "provider-family" && family !== undefined) {
      return `${this.sharedNamespace}:family:${family}`;
    }
    return `${this.namespace}:unit:${index}`;
  }
}
