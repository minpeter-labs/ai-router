import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { addCapturedAbortListener } from "./abort-signal";
import { cloneCallOptions, cloneInitialCallOptions } from "./call-options";
import {
  isTerminalRequestFailure,
  normalizeFailureClassification,
} from "./failure";
import {
  AsyncFilePayloadError,
  MAX_FILE_PAYLOAD_BYTES,
  snapshotFileData,
} from "./file-data";
import type { HealthProbeLease, HealthTransition } from "./health";
import {
  boundedEnumerableOwnKeys,
  hasInvalidHttpHeaderValueCharacter,
  isValidHttpHeaderName,
} from "./http-headers";
import { countJsonContainersUpTo, snapshotJsonValue } from "./json-value";
import {
  runAttemptObservabilityHook,
  runErrorObservabilityHook,
} from "./observability";
import { OrderingTokenSource } from "./ordering";
import {
  copyFailureRecord,
  recordFailure,
  safeShouldRetry,
  surfaceFailure,
} from "./retry";
import {
  captureGenuinePromise,
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  isBoundedIdentifier,
  isDateValue,
  isDenseArray,
  isDottedIdentifier,
  isUint8ArrayValue,
  isUrlValue,
  requireGenuinePromise,
} from "./runtime-types";
import {
  abortControllerSafely,
  clearTimerSafely,
  createAbortControllerSafely,
  effectiveTimeout,
  jitteredBackoff,
  monotonicNow,
  RouterTimeoutError,
  scheduleTimer,
  withTimeout,
} from "./timeout";
import type {
  ClassifyFailure,
  FailureClassification,
  OnRouterAttempt,
  OnRouterError,
  ProviderEntry,
  RouterOrderingToken,
} from "./types";

/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */
export interface ResolvedEntry {
  /** The user's original `ProviderEntry` (surfaced verbatim on `onError`). */
  entry: ProviderEntry;
  /** Index into the full (unfiltered) entries array. */
  fullIndex: number;
  /** The instantiated v4 model. */
  model: LanguageModelV4;
  probeLease?: HealthProbeLease;
}

export interface FallbackStreamArgs {
  acquireCandidate?: (candidate: ResolvedEntry) => number | undefined;
  attemptsStarted?: number;
  attemptTimeout?: number;
  backoff?: number;
  budgetFailureObserved?: boolean;
  budgetSuppressed?: boolean;
  candidateAvailable?: (candidate: ResolvedEntry) => boolean;
  candidateInFlight?: (candidate: ResolvedEntry) => number;
  /** Modality-filtered candidates, in order. */
  candidates: ResolvedEntry[];
  classifyFailure?: ClassifyFailure;
  concurrencyLimit?: (candidate: ResolvedEntry) => number | undefined;
  firstContentTimeout?: number;
  /** The already-awaited stream result of `candidates[startIndex]`. */
  firstResult: LanguageModelV4StreamResult;
  isBudgetFailure?: (failure: FailureClassification) => boolean;
  logicalId: string;
  maxAttempts?: number;
  nextOrderingToken?: () => RouterOrderingToken;
  /** Cooldown hook: commit the candidate at this filtered index as the survivor. */
  onAdvance?: (filteredIndex: number, hadFailure: boolean) => void;
  onAttempt?: OnRouterAttempt;
  onCandidateFailure?: (
    candidate: ResolvedEntry,
    failure: FailureClassification,
    attemptStartedAt: RouterOrderingToken,
    attemptStartedMonotonic: number
  ) => HealthTransition | undefined;
  onCandidateSuccess?: (
    candidate: ResolvedEntry,
    attemptStartedAt: RouterOrderingToken,
    attemptStartedMonotonic: number
  ) => HealthTransition | undefined;
  onError?: OnRouterError;
  onRequestOutcome?: (
    success: boolean,
    eligibleFailure: boolean,
    suppressed: boolean
  ) => void;
  options: LanguageModelV4CallOptions;
  prepareCandidate?: (candidate: ResolvedEntry) => boolean;
  /** Pre-open failures (candidates that threw before `firstResult`) for the aggregate. */
  priorErrors?: unknown[];
  releaseCandidate?: (candidate: ResolvedEntry) => void;
  releaseProbeCandidate?: (candidate: ResolvedEntry) => void;
  /** Retry even after content has streamed (may duplicate output). */
  retryAfterOutput: boolean;
  /** Retry classifier (already resolved). `true` => fall through to the next candidate. */
  shouldRetry: (error: unknown) => boolean;
  startAttemptStartedAt?: number;
  /** Index into `candidates` of the first attempt (the one `firstResult` came from). */
  startIndex: number;
  startInFlight?: number;
  startOrderingToken?: RouterOrderingToken;
  strictStreamValidation?: boolean;
  totalDeadline?: number;
  totalTimeout?: number;
  waitForCandidate?: (
    candidate: ResolvedEntry,
    signal?: AbortSignal
  ) => Promise<number | undefined>;
}

const FALLBACK_STREAM_ARG_KEYS = [
  "acquireCandidate",
  "attemptsStarted",
  "attemptTimeout",
  "backoff",
  "budgetFailureObserved",
  "budgetSuppressed",
  "candidateAvailable",
  "candidateInFlight",
  "candidates",
  "classifyFailure",
  "concurrencyLimit",
  "firstContentTimeout",
  "firstResult",
  "isBudgetFailure",
  "logicalId",
  "maxAttempts",
  "nextOrderingToken",
  "onAdvance",
  "onAttempt",
  "onCandidateFailure",
  "onCandidateSuccess",
  "onError",
  "onRequestOutcome",
  "options",
  "prepareCandidate",
  "priorErrors",
  "releaseCandidate",
  "releaseProbeCandidate",
  "retryAfterOutput",
  "shouldRetry",
  "startAttemptStartedAt",
  "startIndex",
  "startInFlight",
  "startOrderingToken",
  "strictStreamValidation",
  "totalDeadline",
  "totalTimeout",
  "waitForCandidate",
] as const;

function captureFallbackStreamArgPromises(
  value: unknown
): asserts value is FallbackStreamArgs {
  if (consumeGenuinePromise(value)) {
    throw new TypeError("ai-router: stream arguments must be synchronous");
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("ai-router: stream arguments must be an object");
  }
  consumeOwnDataPromiseFields(value, FALLBACK_STREAM_ARG_KEYS);
}

function fallbackStreamArgField(
  source: FallbackStreamArgs,
  key: (typeof FALLBACK_STREAM_ARG_KEYS)[number]
): unknown {
  const value = Reflect.get(source, key);
  if (consumeGenuinePromise(value)) {
    throw new TypeError(`ai-router: stream ${key} must be synchronous`);
  }
  return value;
}

function cancelLateStreamResult(result: LanguageModelV4StreamResult): void {
  try {
    const stream = Reflect.get(result as object, "stream");
    if (consumeGenuinePromise(stream)) {
      return;
    }
    if (typeof stream !== "object" || stream === null) {
      return;
    }
    const cancel = Reflect.get(stream, "cancel");
    if (consumeGenuinePromise(cancel)) {
      return;
    }
    if (typeof cancel !== "function") {
      return;
    }
    consumeGenuinePromise(
      Reflect.apply(cancel, stream, ["late stream result discarded"])
    );
  } catch {
    // Hostile/malformed late results are already detached from routing.
  }
}

/** Cancel a stream result that arrived after its opening attempt was abandoned. */
export function discardLateStreamResult(
  result: LanguageModelV4StreamResult
): void {
  consumeOwnDataPromiseFields(result as object, [
    "request",
    "response",
    "stream",
  ]);
  cancelLateStreamResult(result);
  // A late result bypasses the normal wrapper snapshot. Start transport
  // cancellation first, then reuse the bounded metadata traversal so a large
  // discarded body cannot delay cleanup of the live upstream.
  snapshotStreamResultMetadata(result);
}

/**
 * Framing / metadata stream parts that carry NO visible model output. Before a
 * candidate "commits" (emits real content or a `finish`), these are BUFFERED:
 * if the candidate then fails pre-commit they are discarded (so the failed
 * candidate contributes nothing to the consumer), and if it commits they are
 * flushed ahead of the content. This is what lets a fallback be transparent —
 * the openai-compatible provider emits `response-metadata` (and often
 * `text-start`) on its first chunk before any `text-delta`, so a pre-content
 * error after them must still discard them and fall back cleanly, not leak a
 * half-open text block. `finish` is NOT framing — it is a commit + terminal.
 *
 * A conservative denylist: an unknown future part type is treated as content
 * (committing), so we never risk re-emitting it across a fallback.
 */
const FRAMING_PARTS: ReadonlySet<string> = new Set([
  "stream-start",
  "response-metadata",
  "text-start",
  "text-end",
  "reasoning-start",
  "reasoning-end",
  "tool-input-start",
  "tool-input-end",
  "raw",
]);

function streamSignalAborted(signal: AbortSignal | undefined): boolean {
  try {
    const aborted = signal?.aborted;
    return !consumeGenuinePromise(aborted) && aborted === true;
  } catch {
    return false;
  }
}

function streamAbortReason(signal: AbortSignal | undefined): unknown {
  try {
    const reason = signal?.reason;
    return consumeGenuinePromise(reason)
      ? new DOMException("aborted", "AbortError")
      : (reason ?? new DOMException("aborted", "AbortError"));
  } catch {
    return new DOMException("aborted", "AbortError");
  }
}

function streamCancelReason(reason: unknown): unknown {
  return consumeGenuinePromise(reason)
    ? new DOMException("aborted", "AbortError")
    : reason;
}
const MAX_PRELUDE_PARTS = 1024;
const MAX_PRELUDE_TEXT_CHARS = 1_048_576;
const MAX_PRELUDE_METADATA_NODES = 10_000;
const MAX_STREAM_WARNINGS = 1024;
const MAX_STREAM_WARNING_CHARS = 1_048_576;
const MAX_STREAM_WARNING_FIELD_LENGTH = 65_536;
const MAX_STREAM_JSON_CONTAINERS = 50_000;
const MAX_STREAM_JSON_CHARACTERS = 4_194_304;
const MAX_STREAM_METADATA_CHARACTERS = 4_194_304;
const MAX_STREAM_METADATA_FIELD_LENGTH = 65_536;
const MAX_STRICT_TRACKED_IDS = 1024;
const MAX_STREAM_CANDIDATES = 10_000;
const MAX_STREAM_DURATION_MS = 86_400_000;
const fallbackOrderingTokens = new OrderingTokenSource();
const ORDERING_TOKEN_RE = /^v1:(\d{13,}):([^:]+):(\d{6})$/;
const FINISH_REASONS = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
]);
const PROVIDER_METADATA_PARTS = new Set([
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
  "tool-call",
  "tool-result",
  "tool-approval-request",
  "custom",
  "file",
  "reasoning-file",
  "source",
  "finish",
]);
const STREAM_PART_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "text-start": ["id", "providerMetadata"],
  "text-delta": ["id", "delta", "providerMetadata"],
  "text-end": ["id", "providerMetadata"],
  "reasoning-start": ["id", "providerMetadata"],
  "reasoning-delta": ["id", "delta", "providerMetadata"],
  "reasoning-end": ["id", "providerMetadata"],
  "tool-input-start": [
    "id",
    "toolName",
    "providerMetadata",
    "providerExecuted",
    "dynamic",
    "title",
  ],
  "tool-input-delta": ["id", "delta", "providerMetadata"],
  "tool-input-end": ["id", "providerMetadata"],
  "tool-call": [
    "toolCallId",
    "toolName",
    "input",
    "providerExecuted",
    "dynamic",
    "providerMetadata",
  ],
  "tool-result": [
    "toolCallId",
    "toolName",
    "result",
    "isError",
    "preliminary",
    "dynamic",
    "providerMetadata",
  ],
  "tool-approval-request": ["approvalId", "toolCallId", "providerMetadata"],
  custom: ["kind", "providerMetadata"],
  file: ["mediaType", "data", "providerMetadata"],
  "reasoning-file": ["mediaType", "data", "providerMetadata"],
  source: [
    "sourceType",
    "id",
    "url",
    "title",
    "mediaType",
    "filename",
    "providerMetadata",
  ],
  "stream-start": ["warnings"],
  "response-metadata": ["id", "timestamp", "modelId"],
  finish: ["usage", "finishReason", "providerMetadata"],
  raw: ["rawValue"],
  error: ["error"],
};

class AsyncStreamFieldError extends Error {}

function streamField(value: object, key: string | number): unknown {
  const field = Reflect.get(value, key);
  if (consumeGenuinePromise(field)) {
    throw new AsyncStreamFieldError("async stream part fields are unsupported");
  }
  return field;
}

function streamDiscriminant(
  value: object,
  key: string,
  siblingKeys: readonly string[]
): unknown {
  try {
    return streamField(value, key);
  } catch (error) {
    consumeOwnDataPromiseFields(value, [key, ...siblingKeys]);
    throw error;
  }
}

function captureStreamSiblings(tasks: readonly (() => void)[]): void {
  let asyncFailure: AsyncStreamFieldError | undefined;
  for (const task of tasks) {
    try {
      task();
    } catch (error) {
      if (!(error instanceof AsyncStreamFieldError)) {
        throw error;
      }
      asyncFailure ??= error;
    }
  }
  if (asyncFailure !== undefined) {
    throw asyncFailure;
  }
}

const ASYNC_STREAM_FIELD = Symbol("async stream field");

function captureStreamSiblingValue(
  task: () => unknown,
  failure: { error?: AsyncStreamFieldError }
): unknown | typeof ASYNC_STREAM_FIELD {
  try {
    return task();
  } catch (error) {
    if (!(error instanceof AsyncStreamFieldError)) {
      throw error;
    }
    failure.error ??= error;
    return ASYNC_STREAM_FIELD;
  }
}

function snapshotRecordFields(
  value: object,
  type: unknown,
  fields: readonly string[],
  failure?: { error?: AsyncStreamFieldError }
): Record<string, unknown> {
  consumeOwnDataPromiseFields(value, fields);
  const snapshot: Record<string, unknown> = { type };
  const capturedFailure = failure ?? {};
  for (const field of fields) {
    try {
      snapshot[field] = streamField(value, field);
    } catch (error) {
      if (!(error instanceof AsyncStreamFieldError)) {
        throw error;
      }
      capturedFailure.error ??= error;
    }
  }
  if (failure === undefined && capturedFailure.error !== undefined) {
    throw capturedFailure.error;
  }
  return snapshot;
}

function snapshotStreamFinishReason(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const snapshot = snapshotRecordFields(value, undefined, ["raw", "unified"]);
  return { raw: snapshot.raw, unified: snapshot.unified };
}

interface StreamJsonBudget {
  remaining: number;
  remainingCharacters: number;
  remainingFileBytes: number;
  remainingMetadataCharacters: number;
}

function snapshotStreamFileData(
  value: unknown,
  budget: StreamJsonBudget
): unknown {
  try {
    return snapshotFileData(value, budget);
  } catch (error) {
    if (error instanceof AsyncFilePayloadError) {
      throw new AsyncStreamFieldError(
        "async stream file payload fields are unsupported"
      );
    }
    throw error;
  }
}

function snapshotStreamRequiredJson(
  value: unknown,
  budget: StreamJsonBudget
): unknown {
  const snapshot = snapshotJsonValue(
    value,
    budget.remaining,
    budget.remainingCharacters
  );
  if (!snapshot.valid) {
    if (snapshot.async) {
      throw new AsyncStreamFieldError(
        "async stream JSON fields are unsupported"
      );
    }
    throw new Error("malformed provider JSON value");
  }
  budget.remaining -= snapshot.containers ?? 0;
  budget.remainingCharacters -= snapshot.characters ?? 0;
  return snapshot.value;
}

function isOrdinaryJsonContainer(value: unknown): value is object {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function snapshotStreamRawValue(
  value: unknown,
  budget: StreamJsonBudget
): unknown {
  // Parsed provider chunks are normally JSON. Copy and charge those values to
  // the request-wide budget so a prelude cannot retain an unbounded object
  // graph, and so later provider mutation cannot change an emitted chunk.
  // Preserve opaque runtime values (Response, Uint8Array, class instances,
  // etc.) because LanguageModelV4 deliberately types rawValue as unknown.
  if (isOrdinaryJsonContainer(value)) {
    return snapshotStreamRequiredJson(value, budget);
  }
  if (isUint8ArrayValue(value)) {
    const snapshot = snapshotStreamFileData(
      { data: value, type: "data" },
      budget
    );
    return Reflect.get(snapshot as object, "data");
  }
  if (isUrlValue(value)) {
    const snapshot = snapshotStreamFileData(
      { type: "url", url: value },
      budget
    );
    return Reflect.get(snapshot as object, "url");
  }
  return value;
}

function snapshotStreamProviderMetadata(
  value: unknown,
  budget: StreamJsonBudget
): unknown {
  if (value === undefined) {
    return;
  }
  const snapshot = snapshotStreamRequiredJson(value, budget);
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  ) {
    throw new Error("malformed provider metadata");
  }
  return snapshot;
}

function snapshotStreamUsage(
  value: unknown,
  budget: StreamJsonBudget
): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const fields = snapshotRecordFields(value, undefined, [
    "inputTokens",
    "outputTokens",
    "raw",
  ]);
  const input = fields.inputTokens;
  const output = fields.outputTokens;
  const raw = fields.raw;
  let inputFields: Record<string, unknown> | undefined;
  let outputFields: Record<string, unknown> | undefined;
  let rawSnapshot: unknown;
  captureStreamSiblings([
    () => {
      if (typeof input === "object" && input !== null) {
        inputFields = snapshotRecordFields(input, undefined, [
          "cacheRead",
          "cacheWrite",
          "noCache",
          "total",
        ]);
      }
    },
    () => {
      if (typeof output === "object" && output !== null) {
        outputFields = snapshotRecordFields(output, undefined, [
          "reasoning",
          "text",
          "total",
        ]);
      }
    },
    () => {
      rawSnapshot =
        raw === undefined ? undefined : snapshotStreamRequiredJson(raw, budget);
    },
  ]);
  return {
    inputTokens:
      inputFields === undefined
        ? input
        : {
            cacheRead: inputFields.cacheRead,
            cacheWrite: inputFields.cacheWrite,
            noCache: inputFields.noCache,
            total: inputFields.total,
          },
    outputTokens:
      outputFields === undefined
        ? output
        : {
            reasoning: outputFields.reasoning,
            text: outputFields.text,
            total: outputFields.total,
          },
    raw: rawSnapshot,
  };
}

function snapshotStreamWarning(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const type = streamDiscriminant(value, "type", [
    "details",
    "feature",
    "message",
    "setting",
  ]);
  let fields: string[];
  if (type === "unsupported" || type === "compatibility") {
    fields = ["feature", "details"];
  } else if (type === "deprecated") {
    fields = ["setting", "message"];
  } else {
    fields = ["message"];
  }
  return snapshotRecordFields(value, type, fields);
}

function streamWarningCharacters(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    return 0;
  }
  let characters = 0;
  for (const field of ["feature", "details", "setting", "message"]) {
    const item = Reflect.get(value, field);
    if (typeof item === "string") {
      characters += item.length;
    }
  }
  return characters;
}

function snapshotStreamWarnings(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const length = Reflect.get(value, "length");
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_STREAM_WARNINGS
  ) {
    return new Array(MAX_STREAM_WARNINGS + 1);
  }
  consumeOwnDataPromiseFields(
    value,
    Array.from({ length }, (_, index) => index)
  );
  const snapshot = new Array<unknown>(length);
  let totalChars = 0;
  const failure: { error?: AsyncStreamFieldError } = {};
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return new Array(length);
    }
    const warning = captureStreamSiblingValue(
      () => snapshotStreamWarning(streamField(value, index)),
      failure
    );
    if (warning === ASYNC_STREAM_FIELD) {
      continue;
    }
    snapshot[index] = warning;
    totalChars += streamWarningCharacters(warning);
    if (totalChars > MAX_STREAM_WARNING_CHARS) {
      return [null];
    }
  }
  if (failure.error !== undefined) {
    throw failure.error;
  }
  return snapshot;
}

interface SnapshottedStreamPart {
  known: boolean;
  part: LanguageModelV4StreamPart;
  type: unknown;
}

function snapshotKnownStreamPart(
  value: LanguageModelV4StreamPart,
  budget: StreamJsonBudget
): SnapshottedStreamPart {
  const type = streamDiscriminant(value as object, "type", [
    "approvalId",
    "data",
    "delta",
    "dynamic",
    "error",
    "filename",
    "finishReason",
    "id",
    "input",
    "isError",
    "kind",
    "mediaType",
    "modelId",
    "preliminary",
    "providerExecuted",
    "providerMetadata",
    "rawValue",
    "result",
    "sourceType",
    "timestamp",
    "title",
    "toolCallId",
    "toolName",
    "url",
    "usage",
    "warnings",
  ]);
  if (typeof type !== "string") {
    return { known: false, part: value, type };
  }
  const fields = STREAM_PART_FIELDS[type];
  if (fields === undefined) {
    // Unknown future part types remain opaque pass-through values.
    return { known: false, part: value, type };
  }
  let sourceType: unknown;
  let selectedFields = fields;
  if (type === "source") {
    sourceType = streamDiscriminant(value as object, "sourceType", [
      "filename",
      "id",
      "mediaType",
      "providerMetadata",
      "title",
      "url",
    ]);
    if (sourceType === "url") {
      selectedFields = ["id", "url", "title", "providerMetadata"];
    } else if (sourceType === "document") {
      selectedFields = [
        "id",
        "mediaType",
        "filename",
        "title",
        "providerMetadata",
      ];
    } else {
      selectedFields = ["id", "title", "providerMetadata"];
    }
  }
  const directFailure: { error?: AsyncStreamFieldError } = {};
  const snapshot = snapshotRecordFields(
    value as object,
    type,
    selectedFields,
    directFailure
  );
  if (type === "source") {
    snapshot.sourceType = sourceType;
  }
  const tasks: (() => void)[] = [];
  const directError = directFailure.error;
  if (directError !== undefined) {
    tasks.push(() => {
      throw directError;
    });
  }
  if (PROVIDER_METADATA_PARTS.has(type)) {
    tasks.push(() => {
      snapshot.providerMetadata = snapshotStreamProviderMetadata(
        snapshot.providerMetadata,
        budget
      );
    });
  }
  if (type === "file" || type === "reasoning-file") {
    tasks.push(() => {
      snapshot.data = snapshotStreamFileData(snapshot.data, budget);
    });
  } else if (type === "finish") {
    tasks.push(
      () => {
        snapshot.finishReason = snapshotStreamFinishReason(
          snapshot.finishReason
        );
      },
      () => {
        snapshot.usage = snapshotStreamUsage(snapshot.usage, budget);
      }
    );
  } else if (type === "tool-result") {
    tasks.push(() => {
      snapshot.result = snapshotStreamRequiredJson(snapshot.result, budget);
    });
  } else if (type === "stream-start") {
    tasks.push(() => {
      snapshot.warnings = snapshotStreamWarnings(snapshot.warnings);
    });
  } else if (type === "raw") {
    tasks.push(() => {
      snapshot.rawValue = snapshotStreamRawValue(snapshot.rawValue, budget);
    });
  } else if (type === "response-metadata" && isDateValue(snapshot.timestamp)) {
    tasks.push(() => {
      snapshot.timestamp = new Date(
        Date.prototype.getTime.call(snapshot.timestamp)
      );
    });
  }
  captureStreamSiblings(tasks);
  return {
    known: true,
    part: snapshot as unknown as LanguageModelV4StreamPart,
    type,
  };
}

function validStreamFileData(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (data.type === "data") {
    return typeof data.data === "string" || isUint8ArrayValue(data.data);
  }
  return data.type === "url" && isUrlValue(data.url);
}

function validUsageNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function validOptionalDate(value: unknown): boolean {
  return value === undefined || isDateValue(value);
}

function validOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function validOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function validStreamWarningString(value: unknown): boolean {
  return (
    typeof value === "string" && value.length <= MAX_STREAM_WARNING_FIELD_LENGTH
  );
}

function validWarning(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const warning = value as Record<string, unknown>;
  if (warning.type === "unsupported" || warning.type === "compatibility") {
    return (
      validStreamWarningString(warning.feature) &&
      (warning.details === undefined ||
        validStreamWarningString(warning.details))
    );
  }
  if (warning.type === "deprecated") {
    return (
      validStreamWarningString(warning.setting) &&
      validStreamWarningString(warning.message)
    );
  }
  return warning.type === "other" && validStreamWarningString(warning.message);
}

function validFinishPart(part: LanguageModelV4StreamPart): boolean {
  if (part.type !== "finish") {
    return true;
  }
  const finish = part.finishReason;
  const usage = part.usage;
  if (
    typeof finish !== "object" ||
    finish === null ||
    typeof finish.unified !== "string" ||
    !FINISH_REASONS.has(finish.unified) ||
    !(finish.raw === undefined || typeof finish.raw === "string") ||
    typeof usage !== "object" ||
    usage === null ||
    typeof usage.inputTokens !== "object" ||
    usage.inputTokens === null ||
    typeof usage.outputTokens !== "object" ||
    usage.outputTokens === null
  ) {
    return false;
  }
  return (
    ["total", "noCache", "cacheRead", "cacheWrite"].every((key) =>
      validUsageNumber(
        (usage.inputTokens as unknown as Record<string, unknown>)[key]
      )
    ) &&
    ["total", "text", "reasoning"].every((key) =>
      validUsageNumber(
        (usage.outputTokens as unknown as Record<string, unknown>)[key]
      )
    )
  );
}

function validKnownStreamPartShape(part: LanguageModelV4StreamPart): boolean {
  const record = part as unknown as Record<string, unknown>;
  if (!isBoundedIdentifier(record.type, 256)) {
    return false;
  }
  if (PROVIDER_METADATA_PARTS.has(part.type)) {
    const providerMetadata = Reflect.get(record, "providerMetadata");
    if (
      providerMetadata !== undefined &&
      (typeof providerMetadata !== "object" ||
        providerMetadata === null ||
        Array.isArray(providerMetadata))
    ) {
      return false;
    }
  }
  switch (part.type) {
    case "text-start":
    case "text-end":
    case "reasoning-start":
    case "reasoning-end":
    case "tool-input-end":
      return isBoundedIdentifier(record.id);
    case "text-delta":
    case "reasoning-delta":
    case "tool-input-delta":
      return isBoundedIdentifier(record.id) && typeof record.delta === "string";
    case "tool-input-start":
      return (
        isBoundedIdentifier(record.id) &&
        isBoundedIdentifier(record.toolName) &&
        validOptionalBoolean(record.providerExecuted) &&
        validOptionalBoolean(record.dynamic) &&
        validOptionalString(record.title)
      );
    case "tool-call":
      return (
        isBoundedIdentifier(record.toolCallId) &&
        isBoundedIdentifier(record.toolName) &&
        typeof record.input === "string" &&
        validOptionalBoolean(record.providerExecuted) &&
        validOptionalBoolean(record.dynamic)
      );
    case "tool-result":
      return (
        isBoundedIdentifier(record.toolCallId) &&
        isBoundedIdentifier(record.toolName) &&
        record.result !== undefined &&
        record.result !== null &&
        validOptionalBoolean(record.isError) &&
        validOptionalBoolean(record.preliminary) &&
        validOptionalBoolean(record.dynamic)
      );
    case "tool-approval-request":
      return (
        isBoundedIdentifier(record.approvalId) &&
        isBoundedIdentifier(record.toolCallId)
      );
    case "custom":
      return isDottedIdentifier(record.kind);
    case "file":
    case "reasoning-file":
      return (
        typeof record.mediaType === "string" && validStreamFileData(record.data)
      );
    case "source":
      return (
        isBoundedIdentifier(record.id) &&
        ((record.sourceType === "url" &&
          typeof record.url === "string" &&
          validOptionalString(record.title)) ||
          (record.sourceType === "document" &&
            typeof record.mediaType === "string" &&
            typeof record.title === "string" &&
            validOptionalString(record.filename)))
      );
    case "response-metadata":
      return (
        validOptionalString(record.id) &&
        validOptionalString(record.modelId) &&
        validOptionalDate(record.timestamp)
      );
    default:
      // Unknown future part types remain pass-through compatible.
      return true;
  }
}

function consumeStreamMetadataStrings(
  part: LanguageModelV4StreamPart,
  budget: StreamJsonBudget
): void {
  const record = part as unknown as Record<string, unknown>;
  const consume = (
    value: unknown,
    maximum = MAX_STREAM_METADATA_FIELD_LENGTH,
    allowEmpty = true
  ) => {
    if (value === undefined) {
      return;
    }
    if (
      typeof value !== "string" ||
      (!allowEmpty && value.length === 0) ||
      value.length > maximum
    ) {
      throw new Error("stream metadata strings must be non-empty and bounded");
    }
    budget.remainingMetadataCharacters -= value.length;
    if (budget.remainingMetadataCharacters < 0) {
      throw new Error("stream metadata exceeds the aggregate string limit");
    }
  };
  switch (part.type) {
    case "text-start":
    case "text-delta":
    case "text-end":
    case "reasoning-start":
    case "reasoning-delta":
    case "reasoning-end":
    case "tool-input-delta":
    case "tool-input-end":
      consume(record.id, 4096);
      break;
    case "tool-input-start":
      consume(record.id, 4096);
      consume(record.toolName, 4096);
      consume(record.title);
      break;
    case "tool-call":
    case "tool-result":
      consume(record.toolCallId, 4096);
      consume(record.toolName, 4096);
      break;
    case "tool-approval-request":
      consume(record.approvalId, 4096);
      consume(record.toolCallId, 4096);
      break;
    case "custom":
      consume(record.kind, 4096);
      break;
    case "file":
    case "reasoning-file":
      consume(record.mediaType, 256, false);
      break;
    case "source":
      consume(record.id, 4096);
      consume(record.url);
      consume(record.title);
      consume(record.mediaType, 256, false);
      consume(record.filename);
      break;
    case "response-metadata":
      consume(record.id, 4096);
      consume(record.modelId, 4096);
      break;
    case "finish": {
      const reason = record.finishReason;
      if (typeof reason === "object" && reason !== null) {
        consume(Reflect.get(reason, "raw"));
      }
      break;
    }
    default:
      break;
  }
}

class IncompleteModelStreamError extends Error {
  readonly code = "incomplete_model_stream";

  constructor() {
    super("ai-router: provider stream closed without a finish part");
    this.name = "IncompleteModelStreamError";
  }
}

class EmptyModelStreamError extends Error {
  readonly code = "empty_model_response";

  constructor() {
    super("ai-router: provider returned an empty model stream");
    this.name = "EmptyModelStreamError";
  }
}

class StreamPreludeOverflowError extends Error {
  readonly code = "stream_prelude_overflow";

  constructor() {
    super(
      `ai-router: provider exceeded the pre-output framing limit (${MAX_PRELUDE_PARTS} parts or ${MAX_PRELUDE_TEXT_CHARS} text characters)`
    );
    this.name = "StreamPreludeOverflowError";
  }
}

class InvalidModelStreamError extends Error {
  readonly code = "invalid_model_stream";

  constructor(message: string, cause?: unknown) {
    super(`ai-router: invalid provider stream: ${message}`, {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "InvalidModelStreamError";
  }
}

export class RouterStreamError extends Error {
  readonly code = "stream_unavailable";

  constructor(cause: unknown) {
    super("ai-router: stream infrastructure is unavailable", { cause });
    this.name = "RouterStreamError";
  }
}

class CleanedStreamSetupError extends Error {
  constructor(cause: unknown) {
    super("stream setup failed after cleanup", { cause });
    this.name = "CleanedStreamSetupError";
  }
}

class StreamLifecycleValidator {
  private finished = false;
  private readonly open = new Set<string>();
  private readonly pendingToolCalls = new Set<string>();
  private readonly seenToolCalls = new Set<string>();
  private responseMetadataSeen = false;
  private streamStarted = false;

  validate(part: LanguageModelV4StreamPart): void {
    if (this.finished) {
      throw new InvalidModelStreamError("part emitted after finish");
    }
    if (this.validateSpecialPart(part)) {
      return;
    }
    if (!this.streamStarted) {
      throw new InvalidModelStreamError(
        `${part.type} emitted before stream-start`
      );
    }
    const record = part as unknown as Record<string, unknown>;
    const id = isBoundedIdentifier(record.id) ? record.id : undefined;
    const family = part.type.split("-")[0];
    const key = id === undefined ? undefined : `${family}:${id}`;
    if (part.type.endsWith("-start") && key !== undefined) {
      if (this.open.has(key)) {
        throw new InvalidModelStreamError(`duplicate ${part.type}`);
      }
      this.assertTrackingCapacity(
        this.open,
        key,
        "too many open stream blocks"
      );
      this.open.add(key);
    } else if (part.type.endsWith("-delta") && key !== undefined) {
      if (!this.open.has(key)) {
        throw new InvalidModelStreamError(`${part.type} without start`);
      }
    } else if (
      part.type.endsWith("-end") &&
      key !== undefined &&
      !this.open.delete(key)
    ) {
      throw new InvalidModelStreamError(`${part.type} without start`);
    }
    if (part.type === "tool-input-end") {
      this.assertTrackingCapacity(
        this.pendingToolCalls,
        part.id,
        "too many pending tool calls"
      );
      this.pendingToolCalls.add(part.id);
    }
  }

  private assertTrackingCapacity(
    values: Set<string>,
    value: string,
    message: string
  ): void {
    if (!values.has(value) && values.size >= MAX_STRICT_TRACKED_IDS) {
      throw new InvalidModelStreamError(message);
    }
  }

  private validateSpecialPart(part: LanguageModelV4StreamPart): boolean {
    if (part.type === "finish") {
      if (!this.streamStarted) {
        throw new InvalidModelStreamError("finish emitted before stream-start");
      }
      if (this.open.size > 0) {
        throw new InvalidModelStreamError("finish emitted with open blocks");
      }
      if (this.pendingToolCalls.size > 0) {
        throw new InvalidModelStreamError(
          "finish emitted before completed tool inputs produced tool calls"
        );
      }
      this.finished = true;
      return true;
    }
    if (part.type === "stream-start") {
      if (this.streamStarted) {
        throw new InvalidModelStreamError("duplicate stream-start");
      }
      this.streamStarted = true;
      return true;
    }
    if (part.type === "tool-call") {
      if (!this.streamStarted) {
        throw new InvalidModelStreamError(
          "tool-call emitted before stream-start"
        );
      }
      if (this.seenToolCalls.has(part.toolCallId)) {
        throw new InvalidModelStreamError("duplicate tool-call id");
      }
      this.assertTrackingCapacity(
        this.seenToolCalls,
        part.toolCallId,
        "too many tool-call ids"
      );
      this.seenToolCalls.add(part.toolCallId);
      this.pendingToolCalls.delete(part.toolCallId);
      return true;
    }
    if (part.type === "response-metadata") {
      if (!this.streamStarted) {
        throw new InvalidModelStreamError(
          "response-metadata emitted before stream-start"
        );
      }
      if (this.responseMetadataSeen) {
        throw new InvalidModelStreamError("duplicate response-metadata");
      }
      this.responseMetadataSeen = true;
      return true;
    }
    return false;
  }
}

interface CapturedReader {
  cancel(reason?: unknown): Promise<void>;
  read(): Promise<ReadableStreamReadResult<LanguageModelV4StreamPart>>;
  releaseLock(): void;
}

function snapshotReadResult(
  value: unknown
): ReadableStreamReadResult<LanguageModelV4StreamPart> {
  if (typeof value !== "object" || value === null) {
    throw new InvalidModelStreamError("stream read result is malformed");
  }
  consumeOwnDataPromiseFields(value, ["done", "value"]);
  const done = streamField(value, "done");
  if (typeof done !== "boolean") {
    throw new InvalidModelStreamError("stream read result is malformed");
  }
  return done
    ? { done: true, value: undefined }
    : {
        done: false,
        value: streamField(value, "value") as LanguageModelV4StreamPart,
      };
}

function tryReaderMethod(
  reader: object,
  method: "cancel" | "read" | "releaseLock"
): { error?: unknown; value?: unknown } {
  try {
    const value = Reflect.get(reader, method);
    if (consumeGenuinePromise(value)) {
      return {
        error: new Error(`stream reader ${method} must be synchronous`),
      };
    }
    return { value };
  } catch (error) {
    return { error };
  }
}

function cleanupPartialReader(
  reader: object,
  cancel: unknown,
  releaseLock: unknown
): void {
  try {
    if (typeof cancel === "function") {
      consumeGenuinePromise(
        Reflect.apply(cancel, reader, ["stream reader capture failed"])
      );
    }
  } catch {
    // Partial reader cleanup is best-effort.
  }
  try {
    if (typeof releaseLock === "function") {
      consumeGenuinePromise(Reflect.apply(releaseLock, reader, []));
    }
  } catch {
    // Partial reader cleanup is best-effort.
  }
}

function cleanupUnreadableStream(stream: object, reason: unknown): void {
  try {
    const cancel = Reflect.get(stream, "cancel");
    if (consumeGenuinePromise(cancel) || typeof cancel !== "function") {
      return;
    }
    consumeGenuinePromise(Reflect.apply(cancel, stream, [reason]));
  } catch {
    // A stream that cannot expose a reader is detached from routing; cleanup is
    // best-effort and must not replace the reader-capture failure.
  }
}

function captureReader(result: LanguageModelV4StreamResult): CapturedReader {
  const stream = Reflect.get(result as object, "stream");
  if (consumeGenuinePromise(stream)) {
    throw new Error("stream must be synchronous");
  }
  if (typeof stream !== "object" || stream === null) {
    throw new Error("stream is unavailable");
  }
  let reader: unknown;
  try {
    const getReader = Reflect.get(stream, "getReader");
    if (consumeGenuinePromise(getReader)) {
      throw new Error("stream.getReader must be synchronous");
    }
    if (typeof getReader !== "function") {
      throw new Error("stream.getReader is unavailable");
    }
    reader = Reflect.apply(getReader, stream, []);
    if (consumeGenuinePromise(reader)) {
      throw new Error("stream reader must be synchronous");
    }
    if (typeof reader !== "object" || reader === null) {
      throw new Error("stream reader is unavailable");
    }
  } catch (error) {
    cleanupUnreadableStream(stream, error);
    throw error;
  }
  const cancelResult = tryReaderMethod(reader, "cancel");
  const releaseResult = tryReaderMethod(reader, "releaseLock");
  const readResult = tryReaderMethod(reader, "read");
  const cancel = cancelResult.value;
  const read = readResult.value;
  const releaseLock = releaseResult.value;
  const methodError =
    cancelResult.error ?? releaseResult.error ?? readResult.error;
  if (
    methodError !== undefined ||
    typeof cancel !== "function" ||
    typeof read !== "function" ||
    typeof releaseLock !== "function"
  ) {
    cleanupPartialReader(reader, cancel, releaseLock);
    if (methodError !== undefined) {
      throw methodError;
    }
    throw new Error("stream reader methods are unavailable");
  }
  return {
    cancel(reason) {
      return Reflect.apply(cancel, reader, [reason]) as Promise<void>;
    },
    read() {
      return requireGenuinePromise(
        Reflect.apply(read, reader, []),
        (error) =>
          new InvalidModelStreamError(
            "reader.read must return a genuine Promise",
            error
          )
      );
    },
    releaseLock() {
      consumeGenuinePromise(Reflect.apply(releaseLock, reader, []));
    },
  };
}

/** Cancel an upstream reader, swallowing a sync throw or async rejection. */
const cancelledReaders = new WeakSet<CapturedReader>();

function cancelQuietly(reader: CapturedReader | null, reason: unknown): void {
  cancelAndReleaseReaderQuietly(reader, reason);
}

const releasedReaderLocks = new WeakSet<CapturedReader>();

function releaseReaderLockQuietly(reader: CapturedReader): void {
  if (releasedReaderLocks.has(reader)) {
    return;
  }
  try {
    reader.releaseLock();
    releasedReaderLocks.add(reader);
  } catch {
    // A pending read or already-released reader has no additional safe action.
  }
}

function cancelAndReleaseReaderQuietly(
  reader: CapturedReader | null,
  reason: unknown
): void {
  if (reader === null) {
    return;
  }
  if (cancelledReaders.has(reader)) {
    return;
  }
  cancelledReaders.add(reader);
  let cancellation: unknown;
  try {
    cancellation = reader.cancel(reason);
  } catch {
    // Lock release below remains independently best-effort.
  }
  const promise = captureGenuinePromise(cancellation);
  if (promise === undefined) {
    releaseReaderLockQuietly(reader);
    return;
  }
  let pendingReader: CapturedReader | undefined = reader;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (pendingReader !== undefined) {
      releaseReaderLockQuietly(pendingReader);
      pendingReader = undefined;
    }
    clearTimerSafely(timer);
  };
  try {
    timer = scheduleTimer(finish, 1000);
  } catch {
    finish();
  }
  promise.then(finish, finish);
}

const MAX_STREAM_RESULT_HEADERS = 1024;
const MAX_STREAM_RESULT_HEADER_LENGTH = 65_536;
const MAX_STREAM_RESULT_HEADER_CHARS = 1_048_576;

function safeStreamRequest(
  result: LanguageModelV4StreamResult
): LanguageModelV4StreamResult["request"] {
  try {
    const request = result.request;
    if (request === undefined) {
      return;
    }
    if (consumeGenuinePromise(request)) {
      return;
    }
    if (
      typeof request !== "object" ||
      request === null ||
      Array.isArray(request)
    ) {
      return;
    }
    const body = Reflect.get(request, "body");
    if (body === undefined) {
      return {};
    }
    if (consumeGenuinePromise(body)) {
      return {};
    }
    const snapshot = snapshotJsonValue(body);
    return snapshot.valid ? { body: snapshot.value } : {};
  } catch {
    return;
  }
}

function safeStreamResponse(
  result: LanguageModelV4StreamResult
): LanguageModelV4StreamResult["response"] {
  try {
    const response = result.response;
    if (response === undefined) {
      return;
    }
    if (consumeGenuinePromise(response)) {
      return;
    }
    if (
      typeof response !== "object" ||
      response === null ||
      Array.isArray(response)
    ) {
      return;
    }
    const headers = Reflect.get(response, "headers");
    if (headers === undefined) {
      return {};
    }
    if (consumeGenuinePromise(headers)) {
      return {};
    }
    if (
      typeof headers !== "object" ||
      headers === null ||
      Array.isArray(headers)
    ) {
      return;
    }
    const keys = boundedEnumerableOwnKeys(headers, MAX_STREAM_RESULT_HEADERS);
    if (keys === undefined) {
      return;
    }
    consumeOwnDataPromiseFields(headers, keys);
    if (keys.some((key) => !isValidHttpHeaderName(key))) {
      return;
    }
    const sanitized: Record<string, string> = {};
    let totalChars = 0;
    let asyncFailure = false;
    for (const key of keys) {
      const value = Reflect.get(headers, key);
      if (consumeGenuinePromise(value)) {
        asyncFailure = true;
        continue;
      }
      if (
        typeof value !== "string" ||
        value.length > MAX_STREAM_RESULT_HEADER_LENGTH ||
        hasInvalidHttpHeaderValueCharacter(value)
      ) {
        return;
      }
      totalChars += key.length + value.length;
      if (totalChars > MAX_STREAM_RESULT_HEADER_CHARS) {
        return;
      }
      Object.defineProperty(sanitized, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
    if (asyncFailure) {
      return;
    }
    return { headers: sanitized };
  } catch {
    return;
  }
}

interface StreamMetadataSnapshot {
  request: LanguageModelV4StreamResult["request"];
  response: LanguageModelV4StreamResult["response"];
}

function snapshotStreamResultMetadata(
  result: LanguageModelV4StreamResult
): StreamMetadataSnapshot {
  return {
    request: safeStreamRequest(result),
    response: safeStreamResponse(result),
  };
}

function copyStreamRequest(
  request: LanguageModelV4StreamResult["request"]
): LanguageModelV4StreamResult["request"] {
  if (request === undefined) {
    return;
  }
  if (request.body === undefined) {
    return {};
  }
  const snapshot = snapshotJsonValue(request.body);
  return snapshot.valid ? { body: snapshot.value } : {};
}

function copyStreamResponse(
  response: LanguageModelV4StreamResult["response"]
): LanguageModelV4StreamResult["response"] {
  if (response === undefined) {
    return;
  }
  if (response.headers === undefined) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const key of Object.keys(response.headers)) {
    Object.defineProperty(headers, key, {
      configurable: true,
      enumerable: true,
      value: response.headers[key],
      writable: true,
    });
  }
  return { headers };
}

function runCandidateCleanup(
  cleanup: ((candidate: ResolvedEntry) => void) | undefined,
  candidate: ResolvedEntry | undefined
): void {
  try {
    consumeGenuinePromise(cleanup?.(candidate as ResolvedEntry));
  } catch {
    // Capacity and probe release are independent best-effort cleanup hooks.
  }
}

function runIsolatedCandidateCleanup(
  cleanup: ((candidate: ResolvedEntry) => void) | undefined,
  candidate: ResolvedEntry | undefined
): void {
  if (candidate === undefined) {
    runCandidateCleanup(cleanup, candidate);
    return;
  }
  const hookCandidate = snapshotCandidateForStateHook(candidate);
  runCandidateCleanup(cleanup, hookCandidate);
  consumeCandidateSnapshotPromiseMutations(hookCandidate);
}

function runProbeCandidateCleanup(
  cleanup: ((candidate: ResolvedEntry) => void) | undefined,
  candidate: ResolvedEntry | undefined
): void {
  if (candidate === undefined) {
    runCandidateCleanup(cleanup, candidate);
    return;
  }
  let hookCandidate: ResolvedEntry;
  try {
    hookCandidate = snapshotCandidateForStateHook(candidate);
  } catch {
    runCandidateCleanup(cleanup, candidate);
    return;
  }
  runCandidateCleanup(cleanup, hookCandidate);
  consumeCandidateSnapshotPromiseMutations(hookCandidate);
  try {
    candidate.probeLease = snapshotCandidateProbeLease(
      ownCandidateField(hookCandidate, "probeLease"),
      candidate.fullIndex
    );
  } catch {
    // Keep the last validated canonical lease after malformed cleanup mutation.
  }
}

function isValidOrderingToken(value: unknown): value is RouterOrderingToken {
  return (
    (typeof value === "number" && Number.isFinite(value) && value >= 0) ||
    (typeof value === "string" &&
      value.length <= 256 &&
      ORDERING_TOKEN_RE.test(value))
  );
}

function requireOptionalBooleanHookResult(
  value: unknown,
  name: string
): boolean {
  if (consumeGenuinePromise(value)) {
    throw new TypeError(`ai-router: ${name} hook must return synchronously`);
  }
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`ai-router: ${name} hook must return a boolean`);
  }
  return value;
}

function optionalMetricHookValue(
  hook: ((candidate: ResolvedEntry) => number | undefined) | undefined,
  candidate: ResolvedEntry
): number | undefined {
  try {
    const value = invokeReadOnlyCandidateHook(hook, candidate);
    if (consumeGenuinePromise(value)) {
      return;
    }
    return Number.isSafeInteger(value) && (value as number) >= 0
      ? (value as number)
      : undefined;
  } catch {
    return;
  }
}

function snapshotCandidateForStateHook(
  candidate: ResolvedEntry
): ResolvedEntry {
  const snapshot = {
    entry: candidate.entry,
    fullIndex: candidate.fullIndex,
    ...(candidate.probeLease === undefined
      ? {}
      : { probeLease: { ...candidate.probeLease } }),
  } as ResolvedEntry;
  Object.defineProperty(snapshot, "model", {
    configurable: true,
    enumerable: true,
    get: () => candidate.model,
  });
  return snapshot;
}

function invokeReadOnlyCandidateHook<Args extends unknown[], Result>(
  hook: ((candidate: ResolvedEntry, ...args: Args) => Result) | undefined,
  candidate: ResolvedEntry,
  ...args: Args
): Result | undefined {
  if (hook === undefined) {
    return;
  }
  const hookCandidate = snapshotCandidateForStateHook(candidate);
  try {
    return hook(hookCandidate, ...args);
  } finally {
    consumeCandidateSnapshotPromiseMutations(hookCandidate);
  }
}

function captureOptionalHook<T>(source: object, key: string): T | undefined {
  const hook = Reflect.get(source, key);
  if (hook === undefined) {
    return;
  }
  if (typeof hook !== "function") {
    throw new TypeError(`ai-router: ${key} hook must be a function`);
  }
  return ((...args: unknown[]) => Reflect.apply(hook, source, args)) as T;
}

function captureRequiredHook<T>(source: object, key: string): T {
  const hook = captureOptionalHook<T>(source, key);
  if (hook === undefined) {
    throw new TypeError(`ai-router: ${key} hook must be a function`);
  }
  return hook;
}

function tryCaptureOptionalHook<T>(
  source: object,
  key: string
): { error?: unknown; value?: T } {
  try {
    return { value: captureOptionalHook<T>(source, key) };
  } catch (error) {
    return { error };
  }
}

function snapshotResolvedEntries(value: unknown): ResolvedEntry[] {
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

function ownCandidateField(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return;
  }
}

function snapshotCandidateProbeLease(
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

function consumeCandidateSnapshotPromiseMutations(
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

function consumeFailureClassificationPromiseMutations(
  classification: FailureClassification
): void {
  consumeGenuinePromise(ownCandidateField(classification, "cooldownMs"));
  consumeGenuinePromise(ownCandidateField(classification, "retryAfterMs"));
  consumeGenuinePromise(ownCandidateField(classification, "retryable"));
  consumeGenuinePromise(ownCandidateField(classification, "scope"));
  consumeGenuinePromise(ownCandidateField(classification, "statusCode"));
}

function validHealthTransitionHookResult(
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

function snapshotResolvedEntry(value: unknown, index: number): ResolvedEntry {
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

function setupCleanupCandidate(
  args: FallbackStreamArgs
): ResolvedEntry | undefined {
  try {
    const candidatesDescriptor = Object.getOwnPropertyDescriptor(
      args,
      "candidates"
    );
    const indexDescriptor = Object.getOwnPropertyDescriptor(args, "startIndex");
    if (
      candidatesDescriptor === undefined ||
      !("value" in candidatesDescriptor) ||
      indexDescriptor === undefined ||
      !("value" in indexDescriptor) ||
      !Number.isSafeInteger(indexDescriptor.value) ||
      indexDescriptor.value < 0
    ) {
      return;
    }
    const candidateDescriptor = Object.getOwnPropertyDescriptor(
      candidatesDescriptor.value,
      String(indexDescriptor.value)
    );
    const candidate =
      candidateDescriptor !== undefined && "value" in candidateDescriptor
        ? candidateDescriptor.value
        : undefined;
    return snapshotResolvedEntry(candidate, indexDescriptor.value);
  } catch {
    return;
  }
}

function runSetupCandidateCleanup(
  args: FallbackStreamArgs,
  releaseCandidate: FallbackStreamArgs["releaseCandidate"],
  releaseProbeCandidate: FallbackStreamArgs["releaseProbeCandidate"]
): void {
  const candidate = setupCleanupCandidate(args);
  runIsolatedCandidateCleanup(releaseCandidate, candidate);
  runProbeCandidateCleanup(releaseProbeCandidate, candidate);
}

function snapshotPriorErrors(value: unknown): unknown[] {
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

type FallbackPumpConfig = Pick<
  FallbackStreamArgs,
  | "attemptsStarted"
  | "attemptTimeout"
  | "backoff"
  | "budgetFailureObserved"
  | "budgetSuppressed"
  | "firstContentTimeout"
  | "firstResult"
  | "logicalId"
  | "maxAttempts"
  | "options"
  | "priorErrors"
  | "retryAfterOutput"
  | "startAttemptStartedAt"
  | "startIndex"
  | "startInFlight"
  | "startOrderingToken"
  | "strictStreamValidation"
  | "totalDeadline"
  | "totalTimeout"
>;

function snapshotFallbackPumpConfig(
  source: FallbackStreamArgs,
  candidateCount: number,
  firstResult: LanguageModelV4StreamResult
): FallbackPumpConfig {
  const config = {
    attemptsStarted: Reflect.get(source, "attemptsStarted"),
    attemptTimeout: Reflect.get(source, "attemptTimeout"),
    backoff: Reflect.get(source, "backoff"),
    budgetFailureObserved: Reflect.get(source, "budgetFailureObserved"),
    budgetSuppressed: Reflect.get(source, "budgetSuppressed"),
    firstContentTimeout: Reflect.get(source, "firstContentTimeout"),
    firstResult,
    logicalId: Reflect.get(source, "logicalId"),
    maxAttempts: Reflect.get(source, "maxAttempts"),
    options: Reflect.get(source, "options"),
    priorErrors: Reflect.get(source, "priorErrors"),
    retryAfterOutput: Reflect.get(source, "retryAfterOutput"),
    startAttemptStartedAt: Reflect.get(source, "startAttemptStartedAt"),
    startIndex: Reflect.get(source, "startIndex"),
    startInFlight: Reflect.get(source, "startInFlight"),
    startOrderingToken: Reflect.get(source, "startOrderingToken"),
    strictStreamValidation: Reflect.get(source, "strictStreamValidation"),
    totalDeadline: Reflect.get(source, "totalDeadline"),
    totalTimeout: Reflect.get(source, "totalTimeout"),
  } as FallbackPumpConfig;
  const optionalDuration = (name: string, value: unknown): void => {
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > MAX_STREAM_DURATION_MS)
    ) {
      throw new TypeError(
        `ai-router: stream ${name} must be positive and at most 24h`
      );
    }
  };
  for (const [name, value] of [
    ["attemptTimeout", config.attemptTimeout],
    ["backoff", config.backoff],
    ["firstContentTimeout", config.firstContentTimeout],
    ["totalTimeout", config.totalTimeout],
  ] as const) {
    optionalDuration(name, value);
  }
  const positiveSafeInteger = (name: string, value: unknown): void => {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    ) {
      throw new TypeError(
        `ai-router: stream ${name} must be a positive safe integer`
      );
    }
  };
  positiveSafeInteger("attemptsStarted", config.attemptsStarted);
  positiveSafeInteger("maxAttempts", config.maxAttempts);
  positiveSafeInteger("startInFlight", config.startInFlight);
  if (
    typeof config.startIndex !== "number" ||
    !Number.isSafeInteger(config.startIndex) ||
    config.startIndex < 0 ||
    config.startIndex >= candidateCount
  ) {
    throw new TypeError(
      "ai-router: stream startIndex must identify a candidate"
    );
  }
  for (const [name, value] of [
    ["budgetFailureObserved", config.budgetFailureObserved],
    ["budgetSuppressed", config.budgetSuppressed],
    ["strictStreamValidation", config.strictStreamValidation],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypeError(`ai-router: stream ${name} must be a boolean`);
    }
  }
  if (typeof config.retryAfterOutput !== "boolean") {
    throw new TypeError("ai-router: stream retryAfterOutput must be a boolean");
  }
  if (
    typeof config.logicalId !== "string" ||
    config.logicalId.length < 1 ||
    config.logicalId.length > 256
  ) {
    throw new TypeError(
      "ai-router: stream logicalId must contain 1-256 characters"
    );
  }
  for (const [name, value] of [
    ["firstResult", config.firstResult],
    ["options", config.options],
  ] as const) {
    if (typeof value !== "object" || value === null) {
      throw new TypeError(`ai-router: stream ${name} must be an object`);
    }
  }
  config.options = cloneInitialCallOptions(config.options);
  for (const [name, value] of [
    ["startAttemptStartedAt", config.startAttemptStartedAt],
    ["totalDeadline", config.totalDeadline],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new TypeError(`ai-router: stream ${name} must be a finite number`);
    }
  }
  return config;
}

/**
 * Wrap a stream result so a mid-stream failure transparently falls back to the
 * next candidate. The `request`/`response` metadata getters track whichever
 * candidate is producing the live stream — best-effort, since a consumer that
 * snapshots them at stream-open (as the AI SDK does) keeps the first candidate's
 * values across a later fallback.
 */
export function wrapStreamResult(
  args: FallbackStreamArgs
): LanguageModelV4StreamResult {
  let firstResult: LanguageModelV4StreamResult | undefined;
  let active: StreamMetadataSnapshot = {
    request: undefined,
    response: undefined,
  };
  let initialActivation = true;
  let stream: ReadableStream<LanguageModelV4StreamPart>;
  try {
    captureFallbackStreamArgPromises(args);
    firstResult = fallbackStreamArgField(
      args,
      "firstResult"
    ) as LanguageModelV4StreamResult;
    active = snapshotStreamResultMetadata(firstResult);
    stream = createFallbackStream(
      args,
      (result) => {
        if (initialActivation && result === firstResult) {
          initialActivation = false;
          return;
        }
        initialActivation = false;
        active = snapshotStreamResultMetadata(result);
      },
      firstResult
    );
  } catch (error) {
    const cause =
      error instanceof CleanedStreamSetupError ? error.cause : error;
    if (!(error instanceof CleanedStreamSetupError)) {
      if (firstResult !== undefined) {
        discardLateStreamResult(firstResult);
      }
      const releaseCandidate = tryCaptureOptionalHook<
        FallbackStreamArgs["releaseCandidate"]
      >(args, "releaseCandidate").value;
      const releaseProbeCandidate = tryCaptureOptionalHook<
        FallbackStreamArgs["releaseProbeCandidate"]
      >(args, "releaseProbeCandidate").value;
      try {
        runSetupCandidateCleanup(args, releaseCandidate, releaseProbeCandidate);
      } catch {
        // Preserve the infrastructure failure across hostile candidate access.
      }
    }
    throw isTerminalRequestFailure(cause)
      ? cause
      : new RouterStreamError(cause);
  }
  return {
    stream,
    get request() {
      return copyStreamRequest(active.request);
    },
    get response() {
      return copyStreamResponse(active.response);
    },
  };
}

/**
 * Build the wrapped `ReadableStream`. We own the reader lifecycle (rather than
 * using a `TransformStream`) so the underlying source can be swapped mid-flight.
 *
 * Failure is detected two ways, both routed through `onFailure`:
 *  1. An in-band `{ type: 'error' }` part (the openai-compatible provider does
 *     NOT reject the stream — it enqueues this and closes normally).
 *  2. A rejected `reader.read()` (transport abort / connection drop).
 *
 * Each candidate's leading framing parts are BUFFERED until it "commits" (emits
 * real content or a `finish`). A candidate that fails before committing has its
 * buffered framing DISCARDED and contributes nothing to the consumer — so a
 * fallback emits exactly one clean lifecycle (one stream-start, one text block),
 * never duplicate/half-open parts. Fallback only happens pre-commit unless
 * `retryAfterOutput` is set.
 */
export function createFallbackStream(
  args: FallbackStreamArgs,
  setActive: (result: LanguageModelV4StreamResult) => void,
  firstResult?: LanguageModelV4StreamResult
): ReadableStream<LanguageModelV4StreamPart> {
  captureFallbackStreamArgPromises(args);
  const capturedFirstResult =
    firstResult === undefined
      ? (fallbackStreamArgField(
          args,
          "firstResult"
        ) as LanguageModelV4StreamResult)
      : firstResult;
  let pump: FallbackPump | null = null;
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      pump = new FallbackPump(args, setActive, controller, capturedFirstResult);
      pump.run().catch((error: unknown) => pump?.failUnexpected(error));
    },
    pull() {
      pump?.resume();
    },
    cancel(reason) {
      pump?.cancel(reason);
    },
  });
}

/**
 * Drives one wrapped stream: pumps the active candidate, buffers its framing
 * until it commits, and falls back to the next candidate on a pre-commit
 * failure. Extracted to a class so each step is a small method (rather than one
 * deeply-nested closure).
 */
class FallbackPump {
  private committed = false; // has any candidate emitted output to the consumer?
  private candidateCommitted = false; // has the live candidate emitted content / finished?
  private finished = false; // a `finish` part was emitted; the stream is complete
  private readonly metadataNodeCounts = new WeakMap<object, number>();
  private readonly opaquePartTypes = new WeakMap<object, string>();
  private readonly streamJsonBudget = {
    remainingFileBytes: MAX_FILE_PAYLOAD_BYTES,
    remaining: MAX_STREAM_JSON_CONTAINERS,
    remainingCharacters: MAX_STREAM_JSON_CHARACTERS,
    remainingMetadataCharacters: MAX_STREAM_METADATA_CHARACTERS,
  };
  private candidateBudgetCheckpoint: StreamJsonBudget = {
    ...this.streamJsonBudget,
  };
  private prelude: LanguageModelV4StreamPart[] = []; // buffered framing of the live candidate
  private preludeMetadataNodes = 0;
  private preludeTextChars = 0;
  private cancelled = false;
  private cancelReason: unknown;
  private readonly errors: unknown[];
  private activeReader: CapturedReader | null = null;
  private resumeDemand?: () => void;

  private readonly candidates: ResolvedEntry[];
  private readonly config: FallbackPumpConfig;
  private readonly acquireCandidate: FallbackStreamArgs["acquireCandidate"];
  private readonly candidateAvailable: FallbackStreamArgs["candidateAvailable"];
  private readonly candidateInFlight: FallbackStreamArgs["candidateInFlight"];
  private readonly concurrencyLimit: FallbackStreamArgs["concurrencyLimit"];
  private readonly prepareCandidate: FallbackStreamArgs["prepareCandidate"];
  private readonly releaseCandidate: FallbackStreamArgs["releaseCandidate"];
  private readonly releaseProbeCandidate: FallbackStreamArgs["releaseProbeCandidate"];
  private readonly waitForCandidate: FallbackStreamArgs["waitForCandidate"];
  private readonly classifyFailure: FallbackStreamArgs["classifyFailure"];
  private readonly isBudgetFailure: FallbackStreamArgs["isBudgetFailure"];
  private readonly nextOrderingToken: FallbackStreamArgs["nextOrderingToken"];
  private readonly onAdvance: FallbackStreamArgs["onAdvance"];
  private readonly onAttempt: FallbackStreamArgs["onAttempt"];
  private readonly onCandidateFailure: FallbackStreamArgs["onCandidateFailure"];
  private readonly onCandidateSuccess: FallbackStreamArgs["onCandidateSuccess"];
  private readonly onError: FallbackStreamArgs["onError"];
  private readonly onRequestOutcome: FallbackStreamArgs["onRequestOutcome"];
  private readonly shouldRetry: FallbackStreamArgs["shouldRetry"];
  private readonly setActive: (result: LanguageModelV4StreamResult) => void;
  private readonly controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
  private attemptsStarted: number;
  private attemptStartedAt: number;
  private attemptOrderingToken: RouterOrderingToken;
  private validator = new StreamLifecycleValidator();
  private activeInFlight?: number;
  private activeIndex?: number;
  private pendingFallbackIndex?: number;
  private waitingIndex?: number;
  private cancelledPendingIndex?: number;
  private budgetFailureObserved: boolean;
  private budgetSuppressed: boolean;
  private deferSkippedAttemptEvents = false;
  private readonly deferredSkippedAttemptEvents: Parameters<OnRouterAttempt>[0][] =
    [];
  private requestOutcomeObserved = false;
  private readonly operationAbort = createAbortControllerSafely();
  private removeCallerAbort?: () => void;
  private callerAbortObserved = false;
  private callerAbortReason: unknown;

  constructor(
    args: FallbackStreamArgs,
    setActive: (result: LanguageModelV4StreamResult) => void,
    controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
    firstResult: LanguageModelV4StreamResult
  ) {
    const releaseCandidate = tryCaptureOptionalHook<
      FallbackStreamArgs["releaseCandidate"]
    >(args, "releaseCandidate");
    const releaseProbeCandidate = tryCaptureOptionalHook<
      FallbackStreamArgs["releaseProbeCandidate"]
    >(args, "releaseProbeCandidate");
    this.releaseCandidate = releaseCandidate.value;
    this.releaseProbeCandidate = releaseProbeCandidate.value;
    try {
      if (releaseCandidate.error !== undefined) {
        throw releaseCandidate.error;
      }
      if (releaseProbeCandidate.error !== undefined) {
        throw releaseProbeCandidate.error;
      }
      this.acquireCandidate = captureOptionalHook(args, "acquireCandidate");
      this.candidateAvailable = captureOptionalHook(args, "candidateAvailable");
      this.candidateInFlight = captureOptionalHook(args, "candidateInFlight");
      this.concurrencyLimit = captureOptionalHook(args, "concurrencyLimit");
      this.prepareCandidate = captureOptionalHook(args, "prepareCandidate");
      this.waitForCandidate = captureOptionalHook(args, "waitForCandidate");
      this.classifyFailure = captureOptionalHook(args, "classifyFailure");
      this.isBudgetFailure = captureOptionalHook(args, "isBudgetFailure");
      this.nextOrderingToken = captureOptionalHook(args, "nextOrderingToken");
      this.onAdvance = captureOptionalHook(args, "onAdvance");
      this.onAttempt = captureOptionalHook(args, "onAttempt");
      this.onCandidateFailure = captureOptionalHook(args, "onCandidateFailure");
      this.onCandidateSuccess = captureOptionalHook(args, "onCandidateSuccess");
      this.onError = captureOptionalHook(args, "onError");
      this.onRequestOutcome = captureOptionalHook(args, "onRequestOutcome");
      this.shouldRetry = captureRequiredHook(args, "shouldRetry");
      this.candidates = snapshotResolvedEntries(args.candidates);
      this.config = snapshotFallbackPumpConfig(
        args,
        this.candidates.length,
        firstResult
      );
    } catch (error) {
      try {
        discardLateStreamResult(firstResult);
      } catch {
        // Hostile result access cannot suppress the available lease cleanup.
      }
      try {
        runSetupCandidateCleanup(
          args,
          this.releaseCandidate,
          this.releaseProbeCandidate
        );
      } catch {
        // Malformed candidate access leaves no additional safe cleanup path.
      }
      throw new CleanedStreamSetupError(error);
    }
    this.setActive = setActive;
    this.controller = controller;
    this.errors = snapshotPriorErrors(this.config.priorErrors);
    if (this.config.priorErrors !== undefined) {
      copyFailureRecord(this.config.priorErrors, this.errors);
    }
    this.attemptsStarted = this.config.attemptsStarted ?? 1;
    this.attemptStartedAt = this.config.startAttemptStartedAt ?? monotonicNow();
    this.activeInFlight = this.config.startInFlight;
    this.activeIndex = this.config.startIndex;
    this.budgetFailureObserved = this.config.budgetFailureObserved ?? false;
    this.budgetSuppressed = this.config.budgetSuppressed ?? false;
    this.attemptOrderingToken = isValidOrderingToken(
      this.config.startOrderingToken
    )
      ? this.config.startOrderingToken
      : fallbackOrderingTokens.next();
    const callerSignal = this.config.options.abortSignal;
    if (streamSignalAborted(callerSignal)) {
      abortControllerSafely(
        this.operationAbort,
        this.captureCallerAbortReason(callerSignal)
      );
    } else if (callerSignal !== undefined) {
      const onAbort = () => {
        if (streamSignalAborted(this.operationAbort.signal)) {
          return;
        }
        abortControllerSafely(
          this.operationAbort,
          this.captureCallerAbortReason(callerSignal)
        );
      };
      try {
        this.removeCallerAbort = addCapturedAbortListener(
          callerSignal,
          onAbort
        );
        if (streamSignalAborted(callerSignal)) {
          onAbort();
        }
      } catch (error) {
        abortControllerSafely(this.operationAbort, error);
      }
    }
  }

  run(): Promise<void> {
    return this.pump(this.config.firstResult, this.config.startIndex);
  }

  cancel(reason: unknown): void {
    const callerSignal = this.config.options.abortSignal;
    const callerAborted =
      this.callerAbortObserved || streamSignalAborted(callerSignal);
    const safeReason = callerAborted
      ? this.captureCallerAbortReason(callerSignal)
      : streamCancelReason(reason);
    this.cancelled = true;
    this.cancelReason = safeReason;
    abortControllerSafely(this.operationAbort, safeReason);
    this.cleanupAbortForwarding();
    const reader = this.activeReader;
    this.activeReader = null;
    cancelAndReleaseReaderQuietly(reader, safeReason);
    this.resume();
    if (!callerAborted) {
      if (this.activeIndex === undefined) {
        this.cancelledPendingIndex =
          this.waitingIndex ?? this.pendingFallbackIndex;
      } else {
        this.emitAttempt(this.activeIndex, "cancelled");
      }
    }
    this.releaseActiveCandidate();
  }

  resume(): void {
    const resume = this.resumeDemand;
    this.resumeDemand = undefined;
    resume?.();
  }

  failUnexpected(error: unknown): void {
    cancelQuietly(this.activeReader, error);
    this.releaseActiveCandidate();
    this.safeError(error);
    this.finishRequest(false);
    this.resume();
  }

  private safeEnqueue(part: LanguageModelV4StreamPart): void {
    try {
      this.controller.enqueue(part);
    } catch {
      // Controller already closed/errored (e.g. after cancel).
    }
  }

  private safeClose(): void {
    try {
      this.controller.close();
    } catch {
      // Already closed.
    }
  }

  private safeError(error: unknown): void {
    try {
      this.controller.error(error);
    } catch {
      // Already closed/errored.
    }
  }

  private flushPrelude(): void {
    for (const part of this.prelude) {
      this.safeEnqueue(part);
    }
    this.prelude = [];
    this.preludeMetadataNodes = 0;
    this.preludeTextChars = 0;
  }

  private emitOnError(error: unknown, idx: number, willRetry: boolean): void {
    const payload = {
      logicalId: this.config.logicalId,
      entry: this.candidates[idx].entry,
      index: this.candidates[idx].fullIndex,
      error,
      phase: this.committed
        ? ("stream-mid" as const)
        : ("stream-open" as const),
      willRetry,
    };
    runErrorObservabilityHook(payload, (event) => this.onError?.(event));
  }

  private recordCandidateFailure(
    idx: number,
    classification: FailureClassification
  ): HealthTransition | undefined {
    const hookClassification = { ...classification };
    try {
      const result = invokeReadOnlyCandidateHook(
        this.onCandidateFailure,
        this.candidates[idx],
        hookClassification,
        this.attemptOrderingToken,
        this.attemptStartedAt
      );
      return validHealthTransitionHookResult(result);
    } catch {
      return;
    } finally {
      consumeFailureClassificationPromiseMutations(hookClassification);
    }
  }

  private recordCandidateSuccess(idx: number): HealthTransition | undefined {
    try {
      const result = invokeReadOnlyCandidateHook(
        this.onCandidateSuccess,
        this.candidates[idx],
        this.attemptOrderingToken,
        this.attemptStartedAt
      );
      return validHealthTransitionHookResult(result);
    } catch {
      return;
    }
  }

  private nextAttemptOrderingToken(): RouterOrderingToken {
    try {
      const token = this.nextOrderingToken?.();
      if (consumeGenuinePromise(token)) {
        throw new TypeError(
          "ai-router: nextOrderingToken hook must return synchronously"
        );
      }
      if (isValidOrderingToken(token)) {
        return token;
      }
    } catch {
      // An optional token source cannot prevent a provider attempt.
    }
    return fallbackOrderingTokens.next();
  }

  private async onFailure(error: unknown, idx: number): Promise<void> {
    const failedInFlight = this.activeInFlight;
    if (this.terminateForCallerAbort()) {
      return;
    }
    // Once this candidate has failed, it must not keep producing an unread
    // body while a fallback is opening. This also releases provider-side
    // sockets and generation work promptly.
    cancelQuietly(this.activeReader, error);
    this.rollbackDiscardedCandidateBudget();
    // The failed candidate's buffered framing is dropped — it never streams.
    this.prelude = [];
    this.preludeMetadataNodes = 0;
    this.preludeTextChars = 0;
    recordFailure(this.errors, error);
    const classification = this.classifyError(error);
    this.observeFailureForBudget(classification);
    const healthTransition = this.recordCandidateFailure(idx, classification);
    this.releaseActiveCandidate();
    const blockedByOutput = this.committed && !this.config.retryAfterOutput;
    const retry = !blockedByOutput && classification.retryable;
    let nextIdx = this.nextAvailableIndex(idx + 1);
    const withinAttemptBudget =
      this.attemptsStarted <
      (this.config.maxAttempts ?? this.candidates.length);
    this.beginDeferredAdmission(retry, withinAttemptBudget, nextIdx);
    let admission: Awaited<ReturnType<FallbackPump["admitNext"]>>;
    try {
      this.emitMaxAttemptSkipsWhenNeeded(retry, nextIdx, withinAttemptBudget);
      admission = await this.admitNext(retry, withinAttemptBudget, nextIdx);
    } finally {
      this.endDeferredAdmission();
    }
    const { acquired, error: admissionError } = admission;
    const willRetry = acquired !== undefined;
    this.emitOnError(error, idx, willRetry);
    this.emitAttempt(
      idx,
      "failure",
      error,
      classification,
      willRetry,
      healthTransition,
      failedInFlight
    );
    this.flushDeferredSkippedAttemptEvents();
    this.emitCancelledPendingAttempt();

    if (blockedByOutput) {
      this.finishRequest(false);
      this.safeError(error);
      return;
    }
    if (admissionError !== undefined) {
      // Admission/backoff control failures terminate the request without
      // turning an earlier provider failure into a retry-budget sample. In
      // particular, a total deadline or caller abort while queued is censored
      // just like the same control error during provider opening.
      this.budgetSuppressed = true;
      this.finishRequest(false);
      this.safeError(admissionError);
      return;
    }
    if (!retry) {
      this.finishRequest(false);
      this.safeError(this.terminalFailure(error, classification));
      return;
    }
    if (!willRetry) {
      this.finishRequest(false);
      this.safeError(surfaceFailure(this.errors, this.config.logicalId));
      return;
    }
    if (this.cancelled) {
      const candidate = this.candidates[acquired.index];
      runIsolatedCandidateCleanup(this.releaseCandidate, candidate);
      runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      return;
    }

    let nextResult: LanguageModelV4StreamResult;
    nextIdx = acquired.index;
    this.activeIndex = nextIdx;
    this.activeInFlight = acquired.inFlight;
    try {
      this.attemptsStarted += 1;
      this.attemptStartedAt = monotonicNow();
      this.attemptOrderingToken = this.nextAttemptOrderingToken();
      const remaining =
        this.config.totalDeadline === undefined
          ? undefined
          : this.config.totalDeadline - monotonicNow();
      if (remaining !== undefined && remaining <= 0) {
        throw new RouterTimeoutError(
          "total_timeout",
          this.config.totalTimeout ?? 0
        );
      }
      const timeout = effectiveTimeout(this.config.attemptTimeout, remaining);
      nextResult = await withTimeout(
        (signal) =>
          this.candidates[nextIdx].model.doStream(
            cloneCallOptions(this.config.options, signal)
          ),
        timeout,
        this.operationAbort.signal,
        remaining !== undefined && timeout === remaining
          ? "total_timeout"
          : "attempt_timeout",
        remaining !== undefined && timeout === remaining
          ? this.config.totalTimeout
          : this.config.attemptTimeout,
        discardLateStreamResult
      );
    } catch (openErr) {
      return this.handleFallbackOpenFailure(openErr, nextIdx);
    }
    return this.pump(nextResult, nextIdx);
  }

  private emitMaxAttemptSkipsWhenNeeded(
    retry: boolean,
    nextIndex: number,
    withinAttemptBudget: boolean
  ): void {
    if (retry && nextIndex < this.candidates.length && !withinAttemptBudget) {
      this.emitMaxAttemptSkips(nextIndex);
    }
  }

  private terminateForCallerAbort(): boolean {
    const callerSignal = this.config.options.abortSignal;
    if (!streamSignalAborted(callerSignal)) {
      return false;
    }
    const reason = this.captureCallerAbortReason(callerSignal);
    cancelQuietly(this.activeReader, reason);
    this.rollbackDiscardedCandidateBudget();
    this.prelude = [];
    this.preludeMetadataNodes = 0;
    this.preludeTextChars = 0;
    this.budgetSuppressed = true;
    this.releaseActiveCandidate();
    this.finishRequest(false);
    this.safeError(reason);
    return true;
  }

  private captureCallerAbortReason(signal: AbortSignal | undefined): unknown {
    if (!this.callerAbortObserved) {
      this.callerAbortObserved = true;
      this.callerAbortReason = streamAbortReason(signal);
    }
    return this.callerAbortReason;
  }

  private rollbackDiscardedCandidateBudget(): void {
    if (!this.candidateCommitted) {
      Object.assign(this.streamJsonBudget, this.candidateBudgetCheckpoint);
    }
  }

  private handleFallbackOpenFailure(
    error: unknown,
    index: number
  ): Promise<void> | undefined {
    return this.cancelled ? undefined : this.onFailure(error, index);
  }

  private terminalFailure(
    error: unknown,
    classification: FailureClassification
  ): unknown {
    return classification.scope === "request" &&
      classification.statusCode === undefined
      ? error
      : surfaceFailure(this.errors, this.config.logicalId);
  }

  private async admitNext(
    retry: boolean,
    withinAttemptBudget: boolean,
    nextIndex: number
  ): Promise<{
    acquired?: { index: number; inFlight?: number };
    error?: unknown;
  }> {
    if (
      !(retry && withinAttemptBudget) ||
      nextIndex >= this.candidates.length ||
      this.cancelled
    ) {
      return {};
    }
    try {
      await this.backoffBeforeAdmission();
      return { acquired: await this.acquireNext(nextIndex) };
    } catch (error) {
      return { error };
    }
  }

  private backoffBeforeAdmission(): Promise<void> {
    const remaining =
      this.config.totalDeadline === undefined
        ? undefined
        : this.config.totalDeadline - monotonicNow();
    if (remaining !== undefined && remaining <= 0) {
      return Promise.reject(
        new RouterTimeoutError("total_timeout", this.config.totalTimeout ?? 0)
      );
    }
    const maximum =
      remaining === undefined || this.config.backoff === undefined
        ? this.config.backoff
        : Math.min(this.config.backoff, remaining);
    return jitteredBackoff(maximum, this.operationAbort.signal);
  }

  private nextAvailableIndex(startIndex: number): number {
    let index = startIndex;
    while (
      index < this.candidates.length &&
      !requireOptionalBooleanHookResult(
        invokeReadOnlyCandidateHook(
          this.candidateAvailable,
          this.candidates[index]
        ),
        "candidateAvailable"
      )
    ) {
      this.emitSkippedAttempt(index, "cooldown");
      index += 1;
    }
    return index;
  }

  private prepareCandidateBeforeAdmission(candidate: ResolvedEntry): boolean {
    try {
      const prepared = requireOptionalBooleanHookResult(
        this.invokePrepareCandidate(candidate),
        "prepareCandidate"
      );
      if (!prepared) {
        runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      }
      return prepared;
    } catch (error) {
      runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      throw error;
    }
  }

  private prepareOwnedCandidate(candidate: ResolvedEntry): boolean {
    try {
      const prepared = requireOptionalBooleanHookResult(
        this.invokePrepareCandidate(candidate),
        "prepareCandidate"
      );
      if (!prepared) {
        runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      }
      return prepared;
    } catch (error) {
      runIsolatedCandidateCleanup(this.releaseCandidate, candidate);
      runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      throw error;
    }
  }

  private invokePrepareCandidate(candidate: ResolvedEntry): unknown {
    if (this.prepareCandidate === undefined) {
      return;
    }
    const hookCandidate = snapshotCandidateForStateHook(candidate);
    let didThrow = false;
    let thrown: unknown;
    let result: unknown;
    try {
      result = this.prepareCandidate(hookCandidate);
    } catch (error) {
      didThrow = true;
      thrown = error;
    }
    consumeCandidateSnapshotPromiseMutations(hookCandidate);
    try {
      candidate.probeLease = snapshotCandidateProbeLease(
        ownCandidateField(hookCandidate, "probeLease"),
        candidate.fullIndex
      );
    } catch (error) {
      if (!didThrow) {
        didThrow = true;
        thrown = error;
      }
    }
    if (didThrow) {
      throw thrown;
    }
    return result;
  }

  private acquirePreparedCandidate(
    candidate: ResolvedEntry
  ): number | undefined {
    try {
      const inFlight = invokeReadOnlyCandidateHook(
        this.acquireCandidate,
        candidate
      );
      if (consumeGenuinePromise(inFlight)) {
        throw new TypeError(
          "ai-router: admission acquire hook must return synchronously"
        );
      }
      if (
        inFlight !== undefined &&
        (!Number.isSafeInteger(inFlight) || inFlight < 1)
      ) {
        throw new Error(
          "ai-router: admission acquire hook must return a positive safe in-flight count or undefined"
        );
      }
      return inFlight;
    } catch (error) {
      runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      throw error;
    }
  }

  private availableAfterAdmission(candidate: ResolvedEntry): boolean {
    try {
      return requireOptionalBooleanHookResult(
        invokeReadOnlyCandidateHook(this.candidateAvailable, candidate),
        "candidateAvailable"
      );
    } catch (error) {
      runIsolatedCandidateCleanup(this.releaseCandidate, candidate);
      runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      throw error;
    }
  }

  private async acquireNext(
    startIndex: number
  ): Promise<{ index: number; inFlight?: number } | undefined> {
    if (this.acquireCandidate === undefined) {
      return { index: startIndex };
    }
    let lastCapacityIndex: number | undefined;
    for (let index = startIndex; index < this.candidates.length; index++) {
      if (
        !requireOptionalBooleanHookResult(
          invokeReadOnlyCandidateHook(
            this.candidateAvailable,
            this.candidates[index]
          ),
          "candidateAvailable"
        )
      ) {
        this.emitSkippedAttempt(index, "cooldown");
        continue;
      }
      if (!this.prepareCandidateBeforeAdmission(this.candidates[index])) {
        this.emitSkippedAttempt(index, "cooldown");
        continue;
      }
      const inFlight = this.acquirePreparedCandidate(this.candidates[index]);
      if (inFlight !== undefined) {
        if (!this.availableAfterAdmission(this.candidates[index])) {
          runIsolatedCandidateCleanup(
            this.releaseCandidate,
            this.candidates[index]
          );
          runProbeCandidateCleanup(
            this.releaseProbeCandidate,
            this.candidates[index]
          );
          this.emitSkippedAttempt(index, "cooldown");
          continue;
        }
        return { index, inFlight };
      }
      lastCapacityIndex = index;
      runProbeCandidateCleanup(
        this.releaseProbeCandidate,
        this.candidates[index]
      );
      this.emitSkippedAttempt(index, "concurrency");
    }
    if (
      this.waitForCandidate !== undefined &&
      lastCapacityIndex !== undefined
    ) {
      try {
        const acquired = await this.waitForCapacity(lastCapacityIndex);
        if (acquired !== undefined) {
          this.discardDeferredConcurrencySkip(lastCapacityIndex);
        }
        return acquired;
      } catch (error) {
        this.discardDeferredConcurrencySkip(lastCapacityIndex);
        throw error;
      }
    }
    return;
  }

  private async waitForCapacity(
    index: number
  ): Promise<{ index: number; inFlight?: number } | undefined> {
    const candidate = this.candidates[index];
    this.waitingIndex = index;
    let inFlight: number | undefined;
    try {
      const pending = invokeReadOnlyCandidateHook(
        this.waitForCandidate,
        candidate,
        this.operationAbort.signal
      );
      inFlight = await requireGenuinePromise<number | undefined>(
        pending,
        (error) =>
          new Error(
            "ai-router: admission wait hook must return a genuine Promise",
            { cause: error }
          )
      );
    } finally {
      this.waitingIndex = undefined;
    }
    if (inFlight === undefined) {
      this.assertWaitDeadline();
      return;
    }
    if (!Number.isSafeInteger(inFlight) || inFlight < 1) {
      throw new Error(
        "ai-router: admission wait hook must resolve to a positive safe in-flight count or undefined"
      );
    }
    if (!this.prepareOwnedCandidate(candidate)) {
      runIsolatedCandidateCleanup(this.releaseCandidate, candidate);
      this.emitSkippedAttempt(index, "cooldown");
      return;
    }
    if (!this.availableAfterAdmission(candidate)) {
      runIsolatedCandidateCleanup(this.releaseCandidate, candidate);
      runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
      this.emitSkippedAttempt(index, "cooldown");
      return;
    }
    return { index, inFlight };
  }

  private assertWaitDeadline(): void {
    if (
      this.config.totalDeadline !== undefined &&
      monotonicNow() >= this.config.totalDeadline
    ) {
      throw new RouterTimeoutError(
        "total_timeout",
        this.config.totalTimeout ?? 0
      );
    }
  }

  private classifyError(error: unknown): FailureClassification {
    if (
      streamSignalAborted(this.config.options.abortSignal) ||
      (this.classifyFailure === undefined && isTerminalRequestFailure(error))
    ) {
      return { retryable: false, scope: "request" };
    }
    try {
      return normalizeFailureClassification(
        this.classifyFailure === undefined
          ? {
              retryable: safeShouldRetry(this.shouldRetry, error),
              scope: "transient" as const,
            }
          : this.classifyFailure(error)
      );
    } catch {
      return { retryable: false, scope: "request" };
    }
  }

  private emitAttempt(
    idx: number,
    outcome: "success" | "failure" | "cancelled",
    error?: unknown,
    failure?: FailureClassification,
    willRetry?: boolean,
    healthTransition?: HealthTransition,
    inFlight: number | undefined = this.activeInFlight
  ): void {
    const payload = {
      attempt: this.attemptsStarted,
      durationMs: Math.max(0, monotonicNow() - this.attemptStartedAt),
      entry: this.candidates[idx].entry,
      ...(error === undefined ? {} : { error }),
      ...(failure === undefined ? {} : { failure: { ...failure } }),
      ...(healthTransition === undefined ? {} : { healthTransition }),
      index: this.candidates[idx].fullIndex,
      inFlight,
      concurrencyLimit: optionalMetricHookValue(
        this.concurrencyLimit,
        this.candidates[idx]
      ),
      logicalId: this.config.logicalId,
      outcome,
      phase: this.committed
        ? ("stream-mid" as const)
        : ("stream-open" as const),
      ...(willRetry === undefined ? {} : { willRetry }),
    };
    runAttemptObservabilityHook(payload, (event) => this.onAttempt?.(event));
  }

  private emitSkippedAttempt(
    idx: number,
    reason: "concurrency" | "cooldown"
  ): void {
    const payload = {
      durationMs: 0,
      entry: this.candidates[idx].entry,
      index: this.candidates[idx].fullIndex,
      concurrencyLimit: optionalMetricHookValue(
        this.concurrencyLimit,
        this.candidates[idx]
      ),
      ...(reason === "concurrency"
        ? {
            inFlight: optionalMetricHookValue(
              this.candidateInFlight,
              this.candidates[idx]
            ),
          }
        : {}),
      logicalId: this.config.logicalId,
      outcome: "skipped" as const,
      phase: this.committed
        ? ("stream-mid" as const)
        : ("stream-open" as const),
      reason,
    };
    this.emitOrDeferSkippedAttempt(payload);
  }

  private releaseActiveCandidate(): void {
    if (this.activeIndex === undefined) {
      return;
    }
    const candidate = this.candidates[this.activeIndex];
    this.activeIndex = undefined;
    this.activeInFlight = undefined;
    runIsolatedCandidateCleanup(this.releaseCandidate, candidate);
    runProbeCandidateCleanup(this.releaseProbeCandidate, candidate);
  }

  private emitMaxAttemptSkips(startIndex: number): void {
    for (let idx = startIndex; idx < this.candidates.length; idx++) {
      const payload = {
        durationMs: 0,
        entry: this.candidates[idx].entry,
        index: this.candidates[idx].fullIndex,
        concurrencyLimit: optionalMetricHookValue(
          this.concurrencyLimit,
          this.candidates[idx]
        ),
        logicalId: this.config.logicalId,
        outcome: "skipped" as const,
        phase: this.committed
          ? ("stream-mid" as const)
          : ("stream-open" as const),
        reason: "max-attempts" as const,
      };
      this.emitOrDeferSkippedAttempt(payload);
    }
  }

  private emitOrDeferSkippedAttempt(
    payload: Parameters<OnRouterAttempt>[0]
  ): void {
    if (this.deferSkippedAttemptEvents) {
      this.deferredSkippedAttemptEvents.push(payload);
      return;
    }
    runAttemptObservabilityHook(payload, (event) => this.onAttempt?.(event));
  }

  private flushDeferredSkippedAttemptEvents(): void {
    for (const payload of this.deferredSkippedAttemptEvents) {
      runAttemptObservabilityHook(payload, (event) => this.onAttempt?.(event));
    }
    this.deferredSkippedAttemptEvents.length = 0;
  }

  private discardDeferredConcurrencySkip(idx: number): void {
    const index = this.candidates[idx].fullIndex;
    for (
      let position = this.deferredSkippedAttemptEvents.length - 1;
      position >= 0;
      position--
    ) {
      const payload = this.deferredSkippedAttemptEvents[position];
      if (
        payload.index === index &&
        payload.outcome === "skipped" &&
        payload.reason === "concurrency"
      ) {
        this.deferredSkippedAttemptEvents.splice(position, 1);
        return;
      }
    }
  }

  private emitCancelledPendingAttempt(): void {
    const idx = this.cancelledPendingIndex;
    this.cancelledPendingIndex = undefined;
    if (idx === undefined) {
      return;
    }
    const payload = {
      durationMs: 0,
      entry: this.candidates[idx].entry,
      index: this.candidates[idx].fullIndex,
      concurrencyLimit: optionalMetricHookValue(
        this.concurrencyLimit,
        this.candidates[idx]
      ),
      inFlight: optionalMetricHookValue(
        this.candidateInFlight,
        this.candidates[idx]
      ),
      logicalId: this.config.logicalId,
      outcome: "cancelled" as const,
      phase: this.committed
        ? ("stream-mid" as const)
        : ("stream-open" as const),
    };
    runAttemptObservabilityHook(payload, (event) => this.onAttempt?.(event));
  }

  private beginDeferredAdmission(
    retry: boolean,
    withinAttemptBudget: boolean,
    nextIdx: number
  ): void {
    this.deferSkippedAttemptEvents = true;
    this.pendingFallbackIndex =
      retry && withinAttemptBudget && nextIdx < this.candidates.length
        ? nextIdx
        : undefined;
  }

  private endDeferredAdmission(): void {
    this.deferSkippedAttemptEvents = false;
    this.pendingFallbackIndex = undefined;
  }

  // Buffer framing pre-commit, else commit + forward. Returns whether this
  // candidate has been committed to cooldown yet.
  private forwardPart(
    value: LanguageModelV4StreamPart,
    idx: number,
    advanced: boolean
  ): boolean {
    if (this.shouldBufferPart(value)) {
      if (this.candidateCommitted) {
        this.safeEnqueue(value); // post-commit framing passes through
      } else {
        this.prelude.push(value); // pre-commit framing is buffered
        this.preludeMetadataNodes += this.bufferedMetadataNodes(value);
        this.preludeTextChars += this.bufferedTextLength(value);
      }
      return advanced;
    }
    // A commit part: real content, or a `finish` terminal.
    if (!this.candidateCommitted) {
      this.candidateCommitted = true;
      this.committed = true;
      this.flushPrelude();
    }
    this.safeEnqueue(value);
    if (this.partType(value) === "finish") {
      this.finished = true;
      const healthTransition = this.recordCandidateSuccess(idx);
      this.finishRequest(true);
      this.emitAttempt(
        idx,
        "success",
        undefined,
        undefined,
        undefined,
        healthTransition
      );
      this.releaseActiveCandidate();
    }
    if (advanced) {
      return true;
    }
    try {
      consumeGenuinePromise(this.onAdvance?.(idx, this.errors.length > 0));
    } catch {
      // Optional cooldown bookkeeping cannot alter an emitted stream.
    }
    return true;
  }

  private cleanupReader(reader: CapturedReader): void {
    if (this.cancelled) {
      // Propagate the consumer's cancel to the live upstream (this may be a
      // survivor opened during the fallback race) so its transport closes.
      if (this.activeReader === reader) {
        this.activeReader = null;
        cancelAndReleaseReaderQuietly(reader, this.cancelReason);
      }
    } else {
      releaseReaderLockQuietly(reader);
    }
    if (this.activeReader === reader) {
      this.activeReader = null;
    }
  }

  // A read rejection after the stream already finished is just the connection
  // closing — nothing to fall back to; otherwise route it through onFailure.
  private handleReadError(readErr: unknown, idx: number): Promise<void> {
    if (this.finished) {
      this.safeClose();
      return Promise.resolve();
    }
    return this.onFailure(readErr, idx);
  }

  // An in-band error part: ignore after finish; forward verbatim if content
  // already streamed and we won't retry; otherwise fall back (swallowing it).
  private handleErrorPart(
    value: Extract<LanguageModelV4StreamPart, { type: "error" }>,
    idx: number
  ): Promise<void> {
    if (this.finished) {
      this.safeClose();
      return Promise.resolve();
    }
    if (this.committed && !this.config.retryAfterOutput) {
      const classification = this.classifyError(value.error);
      this.observeFailureForBudget(classification);
      const healthTransition = this.recordCandidateFailure(idx, classification);
      this.emitOnError(value.error, idx, false);
      this.emitAttempt(
        idx,
        "failure",
        value.error,
        classification,
        false,
        healthTransition
      );
      this.flushPrelude();
      this.safeEnqueue(value);
      cancelQuietly(this.activeReader, value.error);
      this.releaseActiveCandidate();
      this.finishRequest(false);
      this.safeClose();
      return Promise.resolve();
    }
    return this.onFailure(value.error, idx);
  }

  private async pump(
    result: LanguageModelV4StreamResult,
    idx: number
  ): Promise<void> {
    this.candidateCommitted = false;
    this.candidateBudgetCheckpoint = { ...this.streamJsonBudget };
    this.validator = new StreamLifecycleValidator();
    let reader: CapturedReader | undefined;
    try {
      reader = captureReader(result);
      this.setActive(result);
    } catch (error) {
      cancelQuietly(reader ?? null, error);
      await this.onFailure(
        new InvalidModelStreamError(
          "stream result does not expose a readable stream",
          error
        ),
        idx
      );
      return;
    }
    return this.pumpReader(reader, idx);
  }

  private async pumpReader(reader: CapturedReader, idx: number): Promise<void> {
    this.activeReader = reader;
    let advanced = false; // commit this candidate to cooldown once, on first commit part
    let candidateHasOutput = false;
    const firstContentDeadline =
      this.config.firstContentTimeout === undefined
        ? undefined
        : monotonicNow() + this.config.firstContentTimeout;
    try {
      if (this.cancelled) {
        return;
      }
      for (;;) {
        await this.waitForDemand();
        let res: ReadableStreamReadResult<LanguageModelV4StreamPart>;
        try {
          res = snapshotReadResult(
            await this.readNext(reader, firstContentDeadline)
          );
        } catch (readErr) {
          await this.handleReadRejection(readErr, reader, idx);
          return;
        }
        if (this.cancelled) {
          return;
        }
        if (res.done) {
          if (this.finished) {
            this.flushPrelude();
            this.safeClose();
          } else {
            await this.onFailure(new IncompleteModelStreamError(), idx);
          }
          return;
        }
        const value = await this.snapshotAndValidatePart(res.value, idx);
        if (!this.snapshotCanContinue(value)) {
          return;
        }
        const type = this.partType(value);
        if (type === "error") {
          await this.handleErrorPart(
            value as Extract<LanguageModelV4StreamPart, { type: "error" }>,
            idx
          );
          return;
        }
        if (this.preludeWouldOverflow(value)) {
          await this.onFailure(new StreamPreludeOverflowError(), idx);
          return;
        }
        if (this.isEmptyFinish(value, candidateHasOutput)) {
          await this.onFailure(new EmptyModelStreamError(), idx);
          return;
        }
        if (this.isOutputPart(value)) {
          candidateHasOutput = true;
        }
        advanced = this.forwardPart(value, idx, advanced);
        if (type === "finish") {
          cancelQuietly(reader, "model stream finished");
          this.safeClose();
          return;
        }
      }
    } finally {
      this.cleanupReader(reader);
    }
  }

  private snapshotCanContinue(
    value: LanguageModelV4StreamPart | undefined
  ): value is LanguageModelV4StreamPart {
    return !this.cancelled && value !== undefined;
  }

  private waitForDemand(): Promise<void> {
    if (this.cancelled || (this.controller.desiredSize ?? 0) > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.resumeDemand = resolve;
    });
  }

  private observeFailureForBudget(failure: FailureClassification): void {
    const hookFailure = { ...failure };
    try {
      const result = this.isBudgetFailure?.(hookFailure);
      this.budgetFailureObserved ||=
        !consumeGenuinePromise(result) && result === true;
    } catch {
      // Optional retry-budget classification cannot interrupt fallback.
    } finally {
      consumeFailureClassificationPromiseMutations(hookFailure);
    }
    this.budgetSuppressed ||= !failure.retryable && failure.scope === "request";
  }

  private finishRequest(success: boolean): void {
    if (this.requestOutcomeObserved || this.cancelled) {
      return;
    }
    this.requestOutcomeObserved = true;
    this.cleanupAbortForwarding();
    try {
      consumeGenuinePromise(
        this.onRequestOutcome?.(
          success,
          this.budgetFailureObserved,
          this.budgetSuppressed
        )
      );
    } catch {
      // Optional retry-budget accounting cannot alter stream settlement.
    }
  }

  private cleanupAbortForwarding(): void {
    try {
      this.removeCallerAbort?.();
    } catch {
      // Defensive: custom cleanup extensions cannot alter stream completion.
    }
    this.removeCallerAbort = undefined;
  }

  private handleReadRejection(
    error: unknown,
    reader: CapturedReader,
    index: number
  ): Promise<void> {
    if (this.cancelled) {
      return Promise.resolve();
    }
    cancelAndReleaseReaderQuietly(reader, error);
    return this.handleReadError(error, index);
  }

  private isEmptyFinish(
    value: LanguageModelV4StreamPart,
    candidateHasOutput: boolean
  ): boolean {
    return this.partType(value) === "finish" && !candidateHasOutput;
  }

  private preludeWouldOverflow(value: LanguageModelV4StreamPart): boolean {
    return (
      !this.candidateCommitted &&
      this.shouldBufferPart(value) &&
      (this.prelude.length >= MAX_PRELUDE_PARTS ||
        this.preludeMetadataNodes + this.bufferedMetadataNodes(value) >
          MAX_PRELUDE_METADATA_NODES ||
        this.preludeTextChars + this.bufferedTextLength(value) >
          MAX_PRELUDE_TEXT_CHARS)
    );
  }

  private bufferedMetadataNodes(value: LanguageModelV4StreamPart): number {
    if (!PROVIDER_METADATA_PARTS.has(value.type)) {
      return 0;
    }
    const cached = this.metadataNodeCounts.get(value as object);
    if (cached !== undefined) {
      return cached;
    }
    const count = countJsonContainersUpTo(
      Reflect.get(value as object, "providerMetadata"),
      MAX_PRELUDE_METADATA_NODES + 1
    );
    this.metadataNodeCounts.set(value as object, count);
    return count;
  }

  private bufferedTextLength(value: LanguageModelV4StreamPart): number {
    const type = this.partType(value);
    if (
      type === "text-delta" ||
      type === "reasoning-delta" ||
      type === "tool-input-delta"
    ) {
      return (Reflect.get(value as object, "delta") as string).length;
    }
    if (type === "raw") {
      const rawValue = Reflect.get(value as object, "rawValue");
      return typeof rawValue === "string" ? rawValue.length : 0;
    }
    return 0;
  }

  private isOutputPart(value: LanguageModelV4StreamPart): boolean {
    return !this.shouldBufferPart(value) && this.partType(value) !== "finish";
  }

  private shouldBufferPart(value: LanguageModelV4StreamPart): boolean {
    const type = this.partType(value);
    if (this.config.strictStreamValidation && type === "tool-input-delta") {
      // Strict mode waits for the final tool-call before exposing partial tool
      // input, so a malformed lifecycle can still fall back transparently.
      return true;
    }
    if (type === "text-delta" || type === "reasoning-delta") {
      return (
        (Reflect.get(value as object, "delta") as string).trim().length === 0
      );
    }
    return FRAMING_PARTS.has(type);
  }

  private partType(value: LanguageModelV4StreamPart): string {
    return this.opaquePartTypes.get(value as object) ?? value.type;
  }

  private validatePart(value: LanguageModelV4StreamPart): unknown | undefined {
    try {
      if (!validKnownStreamPartShape(value)) {
        return new InvalidModelStreamError("stream part shape is malformed");
      }
      if (
        value.type === "stream-start" &&
        (!Array.isArray(value.warnings) ||
          value.warnings.length > MAX_STREAM_WARNINGS ||
          !isDenseArray(value.warnings) ||
          !value.warnings.every(validWarning))
      ) {
        return new InvalidModelStreamError("stream warnings are malformed");
      }
      if (!validFinishPart(value)) {
        return new InvalidModelStreamError("finish metadata is malformed");
      }
      if (this.config.strictStreamValidation) {
        this.validator.validate(value);
      }
      return;
    } catch (validationError) {
      return validationError instanceof InvalidModelStreamError
        ? validationError
        : new InvalidModelStreamError("stream metadata could not be read");
    }
  }

  private async snapshotAndValidatePart(
    value: LanguageModelV4StreamPart,
    index: number
  ): Promise<LanguageModelV4StreamPart | undefined> {
    let snapshot: SnapshottedStreamPart;
    try {
      snapshot = snapshotKnownStreamPart(value, this.streamJsonBudget);
      if (snapshot.known) {
        consumeStreamMetadataStrings(snapshot.part, this.streamJsonBudget);
      } else if (isBoundedIdentifier(snapshot.type, 256)) {
        this.opaquePartTypes.set(
          snapshot.part as object,
          snapshot.type as string
        );
      } else {
        throw new Error("unknown stream part type is malformed");
      }
    } catch (error) {
      await this.onFailure(
        new InvalidModelStreamError(
          "stream part properties could not be read",
          error
        ),
        index
      );
      return;
    }
    const validationError = snapshot.known
      ? this.validatePart(snapshot.part)
      : undefined;
    if (validationError !== undefined) {
      await this.onFailure(validationError, index);
      return;
    }
    return snapshot.part;
  }

  private readNext(
    reader: CapturedReader,
    firstContentDeadline: number | undefined
  ): Promise<ReadableStreamReadResult<LanguageModelV4StreamPart>> {
    const timeoutMs =
      this.candidateCommitted || firstContentDeadline === undefined
        ? undefined
        : Math.max(0, firstContentDeadline - monotonicNow());
    if (timeoutMs === 0) {
      throw new RouterTimeoutError(
        "first_content_timeout",
        this.config.firstContentTimeout ?? 0
      );
    }
    return withTimeout(
      () => reader.read(),
      timeoutMs,
      this.operationAbort.signal,
      "first_content_timeout",
      this.config.firstContentTimeout
    );
  }
}
