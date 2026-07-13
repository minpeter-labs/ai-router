import { CandidateHealthTransitions } from "./candidate-health-transitions";
import { compareTokens, redactHealthKey } from "./health-record";
import { cloneHealthRecord, type HealthProbeLease } from "./health-store";
import type { RouterHealthRecord, RouterHealthSnapshot } from "./types";

export class CandidateHealthState extends CandidateHealthTransitions {
  register(index: number, healthKey?: string, family?: string): void {
    this.keys(index, healthKey, family);
  }

  available(index: number, healthKey?: string, family?: string): boolean {
    const now = this.clockNow();
    const keys = this.keys(index, healthKey, family);
    const records = keys
      .map((key) => ({ key, health: this.recordForKey(key, now) }))
      .filter(
        (item): item is { key: string; health: RouterHealthRecord } =>
          item.health !== undefined
      );
    if (
      records.some(
        ({ health }) =>
          (health.failures > 0 && health.cooldownUntil > now) ||
          (health.probingUntil ?? 0) > now
      )
    ) {
      return false;
    }
    return true;
  }

  claimProbe(index: number, healthKey?: string, family?: string): boolean {
    const now = this.clockNow();
    const keys = this.keys(index, healthKey, family);
    this.pruneExpiredClaimedProbes(keys, now);
    const records = keys
      .map((key) => ({ key, record: this.recordForKey(key, now) }))
      .filter(
        (item): item is { key: string; record: RouterHealthRecord } =>
          item.record !== undefined && item.record.failures > 0
      );
    if (records.length === 0) {
      return true;
    }
    if (
      records.some(
        ({ record }) =>
          record.cooldownUntil > now || (record.probingUntil ?? 0) > now
      )
    ) {
      return false;
    }
    const probe = records.sort((left, right) =>
      compareTokens(right.record.lastFailureAt, left.record.lastFailureAt)
    )[0];
    if (this.localWriteFailures.has(probe.key)) {
      return this.claimLocalLease(probe.key, probe.record, now);
    }
    return this.claimLease(probe.key, probe.record, now);
  }

  probe(index: number, healthKey?: string, family?: string): boolean {
    const now = this.clockNow();
    const keys = this.keys(index, healthKey, family);
    this.pruneExpiredClaimedProbes(keys, now);
    const records = keys
      .map((key) => ({ key, record: this.recordForKey(key, now) }))
      .filter(
        (item): item is { key: string; record: RouterHealthRecord } =>
          item.record !== undefined && item.record.failures > 0
      );
    if (
      records.some(
        ({ record }) =>
          record.cooldownUntil > now || (record.probingUntil ?? 0) > now
      )
    ) {
      return false;
    }
    const probe = records.sort((left, right) =>
      compareTokens(right.record.lastFailureAt, left.record.lastFailureAt)
    )[0];
    if (probe === undefined) {
      return false;
    }
    if (this.localWriteFailures.has(probe.key)) {
      return this.claimLocalLease(probe.key, probe.record, now);
    }
    return this.claimLease(probe.key, probe.record, now);
  }

  takeProbeLease(
    index: number,
    healthKey?: string,
    family?: string
  ): HealthProbeLease | undefined {
    for (const key of this.keys(index, healthKey, family)) {
      const lease = this.claimedProbes.get(key);
      if (lease !== undefined) {
        this.claimedProbes.delete(key);
        if (
          lease.source === "local" &&
          this.localWriteFailures.get(key)?.probingUntil !== lease.probingUntil
        ) {
          continue;
        }
        return lease;
      }
    }
    return;
  }

  releaseProbe(lease: HealthProbeLease | undefined): void {
    if (lease === undefined) {
      return;
    }
    if (lease.source === "local") {
      const local = this.localWriteFailures.get(lease.key);
      if (local?.probingUntil === lease.probingUntil) {
        const { probingUntil: _, ...released } = local;
        this.setLocalWriteFailure(lease.key, released);
      }
      return;
    }
    const local = this.localWriteFailures.get(lease.key);
    if (local?.probingUntil === lease.probingUntil) {
      const { probingUntil: _, ...released } = local;
      this.setLocalWriteFailure(lease.key, released);
    }
    this.update(lease.key, (current) => {
      if (current?.probingUntil !== lease.probingUntil) {
        return { result: false };
      }
      const { probingUntil: _, ...record } = current;
      return { record, result: true };
    });
  }

  snapshot(): RouterHealthSnapshot[] {
    const now = this.clockNow();
    return [...this.knownKeys].flatMap((key) => {
      const record = this.recordForKey(key, now);
      return record === undefined || record.failures === 0
        ? []
        : [{ key: redactHealthKey(key), record: cloneHealthRecord(record) }];
    });
  }
}
