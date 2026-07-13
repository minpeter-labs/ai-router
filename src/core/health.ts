import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";
import type {
  FailureClassification,
  RouterHealthRecord,
  RouterHealthSnapshot,
  RouterHealthStore,
  RouterOrderingToken,
} from "./types";

const DEFAULT_TRANSIENT_MS = 15_000;
const DEFAULT_CREDENTIAL_MS = 60_000;
const MAX_COOLDOWN_MS = 3_600_000;
const PROBE_LEASE_MS = 30_000;
const MAX_LOCAL_WRITE_FAILURES = 100_000;
const HEALTH_CLOCK_SKEW_MS = 300_000;
const HEALTH_STALE_AFTER_MS = 86_400_000;
const STRING_TOKEN_RE = /^v1:(\d{13,}):([^:]+):(\d{6})$/;
const HEALTH_RECORD_KEYS = [
  "cooldownUntil",
  "failures",
  "lastFailureAt",
  "lastStatus",
  "lastSuccessAt",
  "observedAtMs",
  "probingUntil",
  "version",
] as const;

function validHealthNow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isFinite(value + MAX_COOLDOWN_MS) &&
    value + DEFAULT_TRANSIENT_MS > value
  );
}

function stringTokenTimestamp(token: string): bigint | undefined {
  const match = STRING_TOKEN_RE.exec(token);
  if (match === null) {
    return;
  }
  try {
    return BigInt(match[1]);
  } catch {
    return;
  }
}

function validOrderingToken(value: unknown): value is RouterOrderingToken {
  return (
    (typeof value === "number" && Number.isFinite(value) && value >= 0) ||
    (typeof value === "string" &&
      value.length <= 256 &&
      stringTokenTimestamp(value) !== undefined)
  );
}

function consumeAsyncResult(value: unknown): boolean {
  return consumeGenuinePromise(value);
}

function invalidStoreMutationResult(value: unknown): boolean {
  return (
    consumeAsyncResult(value) ||
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  );
}

function validOptionalHttpStatus(value: number | undefined): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && value >= 100 && value <= 599)
  );
}

function snapshotHealthRecord(value: object): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  consumeOwnDataPromiseFields(value, HEALTH_RECORD_KEYS);
  for (const key of HEALTH_RECORD_KEYS) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) {
        snapshot[key] = descriptor.value;
      }
    } catch {
      // A hostile descriptor boundary degrades to a malformed record without
      // executing caller getters, prototype extensions, or key enumeration.
    }
  }
  return snapshot;
}

function normalizedRecord(value: unknown): RouterHealthRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  try {
    const record = snapshotHealthRecord(value);
    const cooldownUntil = record.cooldownUntil;
    const failures = record.failures;
    if (
      typeof cooldownUntil !== "number" ||
      !Number.isFinite(cooldownUntil) ||
      cooldownUntil < 0 ||
      typeof failures !== "number" ||
      !Number.isSafeInteger(failures) ||
      failures < 0
    ) {
      return;
    }
    const finiteOptional = (key: string): number | undefined | false => {
      const item = record[key];
      if (item === undefined) {
        return;
      }
      return typeof item === "number" && Number.isFinite(item) ? item : false;
    };
    const observedAtMs = finiteOptional("observedAtMs");
    const probingUntil = finiteOptional("probingUntil");
    const lastStatus = finiteOptional("lastStatus");
    const version = finiteOptional("version");
    const lastFailureAt = record.lastFailureAt;
    const lastSuccessAt = record.lastSuccessAt;
    if (
      observedAtMs === false ||
      probingUntil === false ||
      lastStatus === false ||
      version === false ||
      (observedAtMs !== undefined && observedAtMs < 0) ||
      (probingUntil !== undefined && probingUntil < 0) ||
      (probingUntil !== undefined && failures === 0) ||
      !validOptionalHttpStatus(lastStatus) ||
      (version !== undefined &&
        (!Number.isSafeInteger(version) || version < 0)) ||
      !(lastFailureAt === undefined || validOrderingToken(lastFailureAt)) ||
      !(lastSuccessAt === undefined || validOrderingToken(lastSuccessAt))
    ) {
      return;
    }
    return {
      cooldownUntil,
      failures,
      ...(lastFailureAt === undefined ? {} : { lastFailureAt }),
      ...(lastStatus === undefined ? {} : { lastStatus }),
      ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
      ...(observedAtMs === undefined ? {} : { observedAtMs }),
      ...(probingUntil === undefined ? {} : { probingUntil }),
      ...(version === undefined ? {} : { version }),
    };
  } catch {
    return;
  }
}

function compareBigInts(
  left: bigint | undefined,
  right: bigint | undefined
): number {
  if (left === undefined || right === undefined) {
    return 0;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareStringTokens(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const timestampOrder = compareBigInts(
    stringTokenTimestamp(left),
    stringTokenTimestamp(right)
  );
  if (timestampOrder !== 0) {
    return timestampOrder;
  }
  return left < right ? -1 : 1;
}

function tokenTime(value: RouterOrderingToken): bigint | undefined {
  return typeof value === "number"
    ? BigInt(Math.floor(value / 4096))
    : stringTokenTimestamp(value);
}

function stringTokenTooFarInFuture(
  value: RouterOrderingToken | undefined,
  now: number
): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = stringTokenTimestamp(value);
  return (
    timestamp !== undefined &&
    timestamp > BigInt(Math.floor(now + HEALTH_CLOCK_SKEW_MS))
  );
}

function compareTokens(
  left: RouterOrderingToken | undefined,
  right: RouterOrderingToken | undefined
): number {
  if (left === undefined || right === undefined) {
    if (left === right) {
      return 0;
    }
    return left === undefined ? -1 : 1;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return compareStringTokens(left, right);
  }
  return compareBigInts(tokenTime(left), tokenTime(right));
}

function sameTimestampDifferentSources(
  left: RouterOrderingToken | undefined,
  right: RouterOrderingToken | undefined
): boolean {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftMatch = STRING_TOKEN_RE.exec(left);
  const rightMatch = STRING_TOKEN_RE.exec(right);
  return (
    leftMatch !== null &&
    rightMatch !== null &&
    leftMatch[1] === rightMatch[1] &&
    leftMatch[2] !== rightMatch[2]
  );
}

function successSupersedesFailure(
  success: RouterOrderingToken | undefined,
  failure: RouterOrderingToken
): boolean {
  return (
    !sameTimestampDifferentSources(success, failure) &&
    compareTokens(success, failure) >= 0
  );
}

function failureAtOrAfterAttempt(
  failure: RouterOrderingToken | undefined,
  attempt: RouterOrderingToken
): boolean {
  return (
    sameTimestampDifferentSources(failure, attempt) ||
    compareTokens(failure, attempt) >= 0
  );
}

function successCanSupersede(
  failure: RouterOrderingToken | undefined,
  success: RouterOrderingToken
): boolean {
  if (failure === undefined) {
    return true;
  }
  if (typeof failure === "string" && typeof success === "string") {
    const failureMatch = STRING_TOKEN_RE.exec(failure);
    const successMatch = STRING_TOKEN_RE.exec(success);
    if (failureMatch !== null && successMatch !== null) {
      const timestampOrder = compareBigInts(
        stringTokenTimestamp(failure),
        stringTokenTimestamp(success)
      );
      if (timestampOrder !== 0) {
        return timestampOrder < 0;
      }
      if (failureMatch[2] !== successMatch[2]) {
        return false;
      }
    }
  }
  return compareTokens(failure, success) <= 0;
}

function newestToken(
  left: RouterOrderingToken | undefined,
  right: RouterOrderingToken
): RouterOrderingToken {
  return compareTokens(left, right) >= 0 ? (left ?? right) : right;
}

function sharedRecordSupersedesLocal(
  shared: RouterHealthRecord | undefined,
  local: RouterHealthRecord
): boolean {
  if (shared === undefined) {
    return false;
  }
  if (local.lastSuccessAt !== undefined) {
    return (
      (shared.lastFailureAt !== undefined &&
        !successCanSupersede(shared.lastFailureAt, local.lastSuccessAt)) ||
      (shared.lastSuccessAt !== undefined &&
        compareTokens(shared.lastSuccessAt, local.lastSuccessAt) > 0)
    );
  }
  return (
    (shared.lastSuccessAt !== undefined &&
      successCanSupersede(local.lastFailureAt, shared.lastSuccessAt)) ||
    compareTokens(shared.lastFailureAt, local.lastFailureAt) > 0 ||
    (shared.observedAtMs ?? 0) > (local.observedAtMs ?? 0)
  );
}

function effectiveHealthRecord(
  shared: RouterHealthRecord | undefined,
  local: RouterHealthRecord | undefined
): RouterHealthRecord | undefined {
  return local !== undefined && !sharedRecordSupersedesLocal(shared, local)
    ? local
    : shared;
}

function fingerprint(value: string): string {
  let hash = 0x9e3779b185ebca87n;
  for (let index = 0; index < value.length; index++) {
    hash = BigInt.asUintN(
      64,
      hash * 0x100000001b3n + BigInt(value.charCodeAt(index))
    );
  }
  return hash.toString(16).padStart(16, "0");
}

function redactHealthKey(key: string): string {
  for (const marker of [":credential:", ":family:"]) {
    const offset = key.indexOf(marker);
    if (offset !== -1) {
      const prefix = key.slice(0, offset + marker.length);
      return `${prefix}#${fingerprint(key.slice(offset + marker.length))}`;
    }
  }
  return key;
}
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

function cloneHealthRecord(value: RouterHealthRecord): RouterHealthRecord {
  return snapshotHealthRecord(value) as unknown as RouterHealthRecord;
}

function resolveCasResult<T>(
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

interface LocalWriteFailureOverlay {
  expirations: Array<{ deadline: number; key: string }>;
  inactive: Map<string, true>;
  records: Map<string, RouterHealthRecord>;
}

function probeExpiryBefore(
  left: { deadline: number; key: string },
  right: { deadline: number; key: string }
): boolean {
  return (
    left.deadline < right.deadline ||
    (left.deadline === right.deadline && left.key < right.key)
  );
}

function pushProbeExpiry(
  heap: Array<{ deadline: number; key: string }>,
  expiry: { deadline: number; key: string }
): void {
  heap.push(expiry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!probeExpiryBefore(expiry, heap[parent])) {
      break;
    }
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = expiry;
}

function popProbeExpiry(
  heap: Array<{ deadline: number; key: string }>
): { deadline: number; key: string } | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (first === undefined || last === undefined || heap.length === 0) {
    return first;
  }
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) {
      break;
    }
    const child =
      right < heap.length && probeExpiryBefore(heap[right], heap[left])
        ? right
        : left;
    if (!probeExpiryBefore(heap[child], last)) {
      break;
    }
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
}

const localWriteFailuresByStore = new WeakMap<
  RouterHealthStore,
  LocalWriteFailureOverlay
>();

export class CandidateHealthState {
  private readonly now: () => number;
  private readonly namespace: string;
  private readonly pruneStaleRecords: boolean;
  private readonly sharedNamespace: string;
  private readonly store: RouterHealthStore;
  private readonly knownKeys = new Set<string>();
  private readonly claimedProbes = new Map<string, HealthProbeLease>();
  private readonly localWriteFailures: Map<string, RouterHealthRecord>;
  private readonly inactiveLocalWriteFailures: Map<string, true>;
  private readonly localProbeExpirations: Array<{
    deadline: number;
    key: string;
  }>;
  private lastValidNow: number | undefined;

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

  snapshot(): RouterHealthSnapshot[] {
    const now = this.clockNow();
    return [...this.knownKeys].flatMap((key) => {
      const record = this.recordForKey(key, now);
      return record === undefined || record.failures === 0
        ? []
        : [{ key: redactHealthKey(key), record: cloneHealthRecord(record) }];
    });
  }

  private keys(index: number, healthKey?: string, family?: string): string[] {
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

  private recordForKey(
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

  private deleteLocalWriteFailure(key: string): void {
    this.localWriteFailures.delete(key);
    this.inactiveLocalWriteFailures.delete(key);
    this.claimedProbes.delete(key);
  }

  private setLocalWriteFailure(
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

  private promoteExpiredLocalProbes(now: number): void {
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

  private compactLocalProbeExpirations(): void {
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

  private claimLocalLease(
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

  private claimLease(
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

  private pruneExpiredClaimedProbes(keys: string[], now: number): void {
    for (const key of keys) {
      const lease = this.claimedProbes.get(key);
      if (lease !== undefined && lease.probingUntil <= now) {
        this.claimedProbes.delete(key);
      }
    }
  }

  private update<T>(
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

  private readForDecision(
    key: string,
    decisionNow: number | undefined
  ): RouterHealthRecord | undefined {
    return decisionNow === undefined
      ? this.read(key)
      : this.read(key, decisionNow);
  }

  private compareAndSet():
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

  private read(
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

  private clockNow(): number {
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

  private failureKey(
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
