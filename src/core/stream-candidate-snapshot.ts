import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { HealthProbeLease, HealthTransition } from "./health-store";
import { consumeGenuinePromise } from "./runtime-types";
import { MAX_STREAM_CANDIDATES } from "./stream-part-fields";
import type { ResolvedEntry } from "./stream-types";
import type { FailureClassification, ProviderEntry } from "./types";

export function snapshotResolvedEntries(value: unknown): ResolvedEntry[] {
  let array = false;
  try {
    array = Array.isArray(value);
  } catch {
    // A revoked Proxy is not a usable candidate container.
  }
  if (!array) {
    throw new TypeError("ai-router: stream candidates must be an array");
  }
  let length: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    length =
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
  } catch {
    throw new TypeError("ai-router: stream candidates length is unavailable");
  }
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > MAX_STREAM_CANDIDATES
  ) {
    throw new TypeError(
      `ai-router: stream candidates must contain 1-${MAX_STREAM_CANDIDATES} entries`
    );
  }
  const snapshot: ResolvedEntry[] = [];
  for (let index = 0; index < length; index++) {
    let candidate: unknown;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      candidate =
        descriptor !== undefined && "value" in descriptor
          ? descriptor.value
          : undefined;
    } catch {
      throw new TypeError(
        `ai-router: stream candidate ${index} is unavailable`
      );
    }
    snapshot.push(snapshotResolvedEntry(candidate, index));
  }
  return snapshot;
}

export function ownCandidateField(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return;
  }
}

export function snapshotCandidateProbeLease(
  value: unknown,
  index: number
): HealthProbeLease | undefined {
  if (value === undefined) {
    return;
  }
  if (consumeGenuinePromise(value)) {
    throw new TypeError(
      `ai-router: stream candidate ${index} probe lease is invalid`
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError(
      `ai-router: stream candidate ${index} probe lease is invalid`
    );
  }
  const key = ownCandidateField(value, "key");
  const probingUntil = ownCandidateField(value, "probingUntil");
  const source = ownCandidateField(value, "source");
  const asyncKey = consumeGenuinePromise(key);
  const asyncProbingUntil = consumeGenuinePromise(probingUntil);
  const asyncSource = consumeGenuinePromise(source);
  if (
    asyncKey ||
    asyncProbingUntil ||
    asyncSource ||
    typeof key !== "string" ||
    key.length < 1 ||
    key.length > 4096 ||
    typeof probingUntil !== "number" ||
    !Number.isFinite(probingUntil) ||
    probingUntil < 0 ||
    (source !== undefined && source !== "local")
  ) {
    throw new TypeError(
      `ai-router: stream candidate ${index} probe lease is invalid`
    );
  }
  return {
    key,
    probingUntil,
    ...(source === "local" ? { source } : {}),
  };
}

export function consumeCandidateSnapshotPromiseMutations(
  candidate: ResolvedEntry
): void {
  consumeGenuinePromise(ownCandidateField(candidate, "entry"));
  consumeGenuinePromise(ownCandidateField(candidate, "fullIndex"));
  consumeGenuinePromise(ownCandidateField(candidate, "model"));
  try {
    snapshotCandidateProbeLease(ownCandidateField(candidate, "probeLease"), 0);
  } catch {
    // Snapshot mutations are discarded; only native Promise consumption matters.
  }
}

export function consumeFailureClassificationPromiseMutations(
  classification: FailureClassification
): void {
  consumeGenuinePromise(ownCandidateField(classification, "cooldownMs"));
  consumeGenuinePromise(ownCandidateField(classification, "retryAfterMs"));
  consumeGenuinePromise(ownCandidateField(classification, "retryable"));
  consumeGenuinePromise(ownCandidateField(classification, "scope"));
  consumeGenuinePromise(ownCandidateField(classification, "statusCode"));
}

export function validHealthTransitionHookResult(
  value: unknown
): HealthTransition | undefined {
  if (consumeGenuinePromise(value)) {
    return;
  }
  switch (value) {
    case "cas-exhausted":
    case "cooling":
    case "deduplicated":
    case "ignored-stale":
    case "recovered":
      return value;
    default:
      return;
  }
}

export function snapshotResolvedEntry(
  value: unknown,
  index: number
): ResolvedEntry {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`ai-router: stream candidate ${index} is invalid`);
  }
  const entry = ownCandidateField(value, "entry");
  const fullIndex = ownCandidateField(value, "fullIndex");
  const probeLease = snapshotCandidateProbeLease(
    ownCandidateField(value, "probeLease"),
    index
  );
  let modelDescriptor: PropertyDescriptor | undefined;
  try {
    modelDescriptor = Object.getOwnPropertyDescriptor(value, "model");
  } catch {
    // The common validation below reports a stable candidate error.
  }
  const modelValue =
    modelDescriptor !== undefined && "value" in modelDescriptor
      ? modelDescriptor.value
      : undefined;
  const modelGetter = modelDescriptor?.get;
  if (consumeGenuinePromise(modelValue)) {
    throw new TypeError(
      `ai-router: stream candidate ${index} model must be synchronous`
    );
  }
  if (
    !(
      ((typeof entry === "object" && entry !== null) ||
        typeof entry === "function") &&
      Number.isSafeInteger(fullIndex)
    ) ||
    (fullIndex as number) < 0 ||
    !(
      (typeof modelValue === "object" && modelValue !== null) ||
      typeof modelValue === "function" ||
      typeof modelGetter === "function"
    )
  ) {
    throw new TypeError(`ai-router: stream candidate ${index} is invalid`);
  }
  const snapshot = {
    entry: entry as ProviderEntry,
    fullIndex: fullIndex as number,
    ...(probeLease === undefined ? {} : { probeLease }),
  } as ResolvedEntry;
  if (typeof modelGetter === "function") {
    let captured: LanguageModelV4 | undefined;
    let resolved = false;
    Object.defineProperty(snapshot, "model", {
      configurable: false,
      enumerable: true,
      get() {
        if (!resolved) {
          const candidateModel = Reflect.apply(modelGetter, value, []);
          if (consumeGenuinePromise(candidateModel)) {
            throw new TypeError(
              `ai-router: stream candidate ${index} model must be synchronous`
            );
          }
          captured = candidateModel as LanguageModelV4;
          resolved = true;
        }
        return captured as LanguageModelV4;
      },
    });
  } else {
    Object.defineProperty(snapshot, "model", {
      configurable: false,
      enumerable: true,
      value: modelValue as LanguageModelV4,
      writable: false,
    });
  }
  return snapshot;
}

export function snapshotPriorErrors(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  let array = false;
  try {
    array = Array.isArray(value);
  } catch {
    // A revoked Proxy is not a usable prior-error container.
  }
  if (!array) {
    throw new TypeError("ai-router: prior stream errors must be an array");
  }
  let length: unknown;
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    length =
      lengthDescriptor !== undefined && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
  } catch {
    throw new TypeError("ai-router: prior stream errors length is unavailable");
  }
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_STREAM_CANDIDATES
  ) {
    throw new TypeError(
      `ai-router: prior stream errors must contain at most ${MAX_STREAM_CANDIDATES} entries`
    );
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index++) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      snapshot[index] =
        descriptor !== undefined && "value" in descriptor
          ? descriptor.value
          : undefined;
    } catch {
      snapshot[index] = undefined;
    }
  }
  return snapshot;
}
