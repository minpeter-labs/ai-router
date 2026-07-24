import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";
import type { RouterHealthRecord, RouterOrderingToken } from "./types";

export const DEFAULT_TRANSIENT_MS = 15_000;
export const DEFAULT_CREDENTIAL_MS = 60_000;
export const MAX_COOLDOWN_MS = 3_600_000;
export const PROBE_LEASE_MS = 30_000;
export const MAX_LOCAL_WRITE_FAILURES = 100_000;
export const HEALTH_CLOCK_SKEW_MS = 300_000;
export const HEALTH_STALE_AFTER_MS = 86_400_000;
export const STRING_TOKEN_RE = /^v1:(\d{13,}):([^:]+):(\d{6})$/;
export const HEALTH_RECORD_KEYS = [
  "cooldownUntil",
  "failures",
  "lastFailureAt",
  "lastStatus",
  "lastSuccessAt",
  "observedAtMs",
  "probingUntil",
  "version",
] as const;

export function validHealthNow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isFinite(value + MAX_COOLDOWN_MS) &&
    value + DEFAULT_TRANSIENT_MS > value
  );
}

export function stringTokenTimestamp(token: string): bigint | undefined {
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

export function validOrderingToken(
  value: unknown
): value is RouterOrderingToken {
  return (
    (typeof value === "number" && Number.isFinite(value) && value >= 0) ||
    (typeof value === "string" &&
      value.length <= 256 &&
      stringTokenTimestamp(value) !== undefined)
  );
}

export function consumeAsyncResult(value: unknown): boolean {
  return consumeGenuinePromise(value);
}

export function invalidStoreMutationResult(value: unknown): boolean {
  return (
    consumeAsyncResult(value) ||
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  );
}

export function validOptionalHttpStatus(value: number | undefined): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && value >= 100 && value <= 599)
  );
}

export function snapshotHealthRecord(value: object): Record<string, unknown> {
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

export function normalizedRecord(
  value: unknown
): RouterHealthRecord | undefined {
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

export function compareBigInts(
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

export function compareStringTokens(left: string, right: string): number {
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

export function tokenTime(value: RouterOrderingToken): bigint | undefined {
  return typeof value === "number"
    ? BigInt(Math.floor(value / 4096))
    : stringTokenTimestamp(value);
}

export function stringTokenTooFarInFuture(
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

export function compareTokens(
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

export function sameTimestampDifferentSources(
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

export function successSupersedesFailure(
  success: RouterOrderingToken | undefined,
  failure: RouterOrderingToken
): boolean {
  return (
    !sameTimestampDifferentSources(success, failure) &&
    compareTokens(success, failure) >= 0
  );
}

export function failureAtOrAfterAttempt(
  failure: RouterOrderingToken | undefined,
  attempt: RouterOrderingToken
): boolean {
  return (
    sameTimestampDifferentSources(failure, attempt) ||
    compareTokens(failure, attempt) >= 0
  );
}

export function successCanSupersede(
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

export function newestToken(
  left: RouterOrderingToken | undefined,
  right: RouterOrderingToken
): RouterOrderingToken {
  return compareTokens(left, right) >= 0 ? (left ?? right) : right;
}

export function sharedRecordSupersedesLocal(
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

export function effectiveHealthRecord(
  shared: RouterHealthRecord | undefined,
  local: RouterHealthRecord | undefined
): RouterHealthRecord | undefined {
  return local !== undefined && !sharedRecordSupersedesLocal(shared, local)
    ? local
    : shared;
}

export function fingerprint(value: string): string {
  let hash = 0x9e3779b185ebca87n;
  for (let index = 0; index < value.length; index++) {
    hash = BigInt.asUintN(
      64,
      hash * 0x100000001b3n + BigInt(value.charCodeAt(index))
    );
  }
  return hash.toString(16).padStart(16, "0");
}

export function redactHealthKey(key: string): string {
  for (const marker of [":credential:", ":family:"]) {
    const offset = key.indexOf(marker);
    if (offset !== -1) {
      const prefix = key.slice(0, offset + marker.length);
      return `${prefix}#${fingerprint(key.slice(offset + marker.length))}`;
    }
  }
  return key;
}
