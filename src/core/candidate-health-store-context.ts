import {
  localWriteFailuresByStore,
  popProbeExpiry,
  pushProbeExpiry,
} from "./health-overlay";
import {
  MAX_LOCAL_WRITE_FAILURES,
  sharedRecordSupersedesLocal,
} from "./health-record";
import { type HealthProbeLease, MemoryRouterHealthStore } from "./health-store";
import type { RouterHealthRecord, RouterHealthStore } from "./types";

export abstract class CandidateHealthStoreContext {
  protected abstract clockNow(): number;

  protected abstract read(
    key: string,
    decisionNow?: number
  ): RouterHealthRecord | undefined;

  protected readonly now: () => number;
  protected readonly namespace: string;
  protected readonly pruneStaleRecords: boolean;
  protected readonly sharedNamespace: string;
  protected readonly store: RouterHealthStore;
  protected readonly knownKeys = new Set<string>();
  protected readonly claimedProbes = new Map<string, HealthProbeLease>();
  protected readonly localWriteFailures: Map<string, RouterHealthRecord>;
  protected readonly inactiveLocalWriteFailures: Map<string, true>;
  protected readonly localProbeExpirations: Array<{
    deadline: number;
    key: string;
  }>;
  protected lastValidNow: number | undefined;

  constructor(
    namespace: string,
    store: RouterHealthStore = new MemoryRouterHealthStore(),
    now: () => number = Date.now,
    sharedNamespace = namespace
  ) {
    this.namespace = namespace;
    this.sharedNamespace = sharedNamespace;
    this.store = store;
    const existingOverlay = localWriteFailuresByStore.get(store);
    const localOverlay = existingOverlay ?? {
      expirations: [],
      inactive: new Map<string, true>(),
      records: new Map<string, RouterHealthRecord>(),
    };
    this.localWriteFailures = localOverlay.records;
    this.inactiveLocalWriteFailures = localOverlay.inactive;
    this.localProbeExpirations = localOverlay.expirations;
    if (existingOverlay === undefined) {
      localWriteFailuresByStore.set(store, localOverlay);
    }
    this.pruneStaleRecords = store instanceof MemoryRouterHealthStore;
    this.now = now;
  }

  protected keys(index: number, healthKey?: string, family?: string): string[] {
    const shared = [
      ...(healthKey === undefined
        ? []
        : [`${this.sharedNamespace}:credential:${healthKey}`]),
      ...(family === undefined
        ? []
        : [`${this.sharedNamespace}:family:${family}`]),
    ];
    const keys = [`${this.namespace}:unit:${index}`, ...shared];
    for (const key of keys) {
      this.knownKeys.add(key);
    }
    return keys;
  }

  protected recordForKey(
    key: string,
    now: number
  ): RouterHealthRecord | undefined {
    const shared = this.read(key, now);
    const local = this.localWriteFailures.get(key);
    if (local === undefined) {
      return shared;
    }
    if (sharedRecordSupersedesLocal(shared, local)) {
      this.deleteLocalWriteFailure(key);
      return shared;
    }
    if (local.lastSuccessAt !== undefined) {
      this.localWriteFailures.delete(key);
      this.localWriteFailures.set(key, local);
      this.inactiveLocalWriteFailures.delete(key);
      this.inactiveLocalWriteFailures.set(key, true);
      return local;
    }
    this.localWriteFailures.delete(key);
    this.localWriteFailures.set(key, local);
    if ((local.probingUntil ?? 0) <= now) {
      this.inactiveLocalWriteFailures.delete(key);
      this.inactiveLocalWriteFailures.set(key, true);
    }
    return local;
  }

  protected deleteLocalWriteFailure(key: string): void {
    this.localWriteFailures.delete(key);
    this.inactiveLocalWriteFailures.delete(key);
    this.claimedProbes.delete(key);
  }

  protected setLocalWriteFailure(
    key: string,
    record: RouterHealthRecord,
    decisionNow = this.clockNow()
  ): void {
    this.promoteExpiredLocalProbes(decisionNow);
    this.deleteLocalWriteFailure(key);
    this.localWriteFailures.set(key, record);
    if ((record.probingUntil ?? 0) <= decisionNow) {
      this.inactiveLocalWriteFailures.set(key, true);
    } else if (record.probingUntil !== undefined) {
      pushProbeExpiry(this.localProbeExpirations, {
        deadline: record.probingUntil,
        key,
      });
    }
    if (this.localWriteFailures.size > MAX_LOCAL_WRITE_FAILURES) {
      const inactive = this.inactiveLocalWriteFailures.keys().next().value;
      if (inactive !== undefined) {
        this.deleteLocalWriteFailure(inactive);
        this.compactLocalProbeExpirations();
        return;
      }
      // Every retained record owns an active probe. Refuse retention of the
      // newest lease rather than revoking an older owner's cleanup identity.
      this.deleteLocalWriteFailure(key);
    }
    this.compactLocalProbeExpirations();
  }

  protected promoteExpiredLocalProbes(now: number): void {
    while (
      (this.localProbeExpirations[0]?.deadline ?? Number.POSITIVE_INFINITY) <=
      now
    ) {
      const expiry = popProbeExpiry(this.localProbeExpirations);
      if (expiry === undefined) {
        return;
      }
      const record = this.localWriteFailures.get(expiry.key);
      if (record?.probingUntil === expiry.deadline) {
        this.inactiveLocalWriteFailures.delete(expiry.key);
        this.inactiveLocalWriteFailures.set(expiry.key, true);
      }
    }
  }

  protected compactLocalProbeExpirations(): void {
    if (
      this.localProbeExpirations.length <=
      this.localWriteFailures.size * 2 + 1024
    ) {
      return;
    }
    this.localProbeExpirations.length = 0;
    for (const [key, record] of this.localWriteFailures) {
      if (record.probingUntil !== undefined) {
        pushProbeExpiry(this.localProbeExpirations, {
          deadline: record.probingUntil,
          key,
        });
      }
    }
  }
}
