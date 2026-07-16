import { snapshotHealthRecord } from "./health-record";
import type { RouterHealthRecord, RouterHealthStore } from "./types";

export type HealthTransition =
  | "cas-exhausted"
  | "cooling"
  | "deduplicated"
  | "ignored-stale"
  | "recovered";

export interface HealthProbeLease {
  key: string;
  probingUntil: number;
  source?: "local";
}

export class RouterHealthUnavailableError extends Error {
  readonly code = "health_unavailable";
  readonly logicalId: string;

  constructor(logicalId: string) {
    super(
      `ai-router: all compatible candidates for "${logicalId}" are unavailable due to health cooldown`
    );
    this.name = "RouterHealthUnavailableError";
    this.logicalId = logicalId;
  }
}

export function cloneHealthRecord(
  value: RouterHealthRecord
): RouterHealthRecord {
  return snapshotHealthRecord(value) as unknown as RouterHealthRecord;
}

export function resolveCasResult<T>(
  result: unknown,
  success: T
): T | "cas-exhausted" | undefined {
  if (result === false) {
    return;
  }
  return result === true ? success : "cas-exhausted";
}

export class MemoryRouterHealthStore implements RouterHealthStore {
  private readonly records = new Map<string, RouterHealthRecord>();
  private readonly maxRecords: number;

  constructor(maxRecords = 100_000) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
      throw new Error(
        "ai-router: memory health store maxRecords must be a positive safe integer"
      );
    }
    this.maxRecords = maxRecords;
  }

  delete(key: string): void {
    this.records.delete(key);
  }

  compareAndSet(
    key: string,
    expectedVersion: number | undefined,
    value: RouterHealthRecord
  ): boolean {
    if (this.records.get(key)?.version !== expectedVersion) {
      return false;
    }
    this.setRecord(key, value);
    return true;
  }

  entries(): IterableIterator<[string, RouterHealthRecord]> {
    return Array.from(
      this.records,
      ([key, value]) =>
        [key, cloneHealthRecord(value)] as [string, RouterHealthRecord]
    ).values();
  }

  get(key: string): RouterHealthRecord | undefined {
    const value = this.records.get(key);
    if (value !== undefined) {
      this.records.delete(key);
      this.records.set(key, value);
    }
    return value === undefined ? undefined : cloneHealthRecord(value);
  }

  set(key: string, value: RouterHealthRecord): void {
    this.setRecord(key, value);
  }

  private setRecord(key: string, value: RouterHealthRecord): void {
    this.records.delete(key);
    this.records.set(key, cloneHealthRecord(value));
    if (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) {
        this.records.delete(oldest);
      }
    }
  }
}
