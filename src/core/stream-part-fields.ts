import { OrderingTokenSource } from "./ordering";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";

/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */

export const FRAMING_PARTS: ReadonlySet<string> = new Set([
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

export function streamSignalAborted(signal: AbortSignal | undefined): boolean {
  try {
    const aborted = signal?.aborted;
    return !consumeGenuinePromise(aborted) && aborted === true;
  } catch {
    return false;
  }
}

export function streamAbortReason(signal: AbortSignal | undefined): unknown {
  try {
    const reason = signal?.reason;
    return consumeGenuinePromise(reason)
      ? new DOMException("aborted", "AbortError")
      : (reason ?? new DOMException("aborted", "AbortError"));
  } catch {
    return new DOMException("aborted", "AbortError");
  }
}

export function streamCancelReason(reason: unknown): unknown {
  return consumeGenuinePromise(reason)
    ? new DOMException("aborted", "AbortError")
    : reason;
}
export const MAX_PRELUDE_PARTS = 1024;
export const MAX_PRELUDE_TEXT_CHARS = 1_048_576;
export const MAX_PRELUDE_METADATA_NODES = 10_000;
export const MAX_STREAM_WARNINGS = 1024;
export const MAX_STREAM_WARNING_CHARS = 1_048_576;
export const MAX_STREAM_WARNING_FIELD_LENGTH = 65_536;
export const MAX_STREAM_JSON_CONTAINERS = 50_000;
export const MAX_STREAM_JSON_CHARACTERS = 4_194_304;
export const MAX_STREAM_METADATA_CHARACTERS = 4_194_304;
export const MAX_STREAM_METADATA_FIELD_LENGTH = 65_536;
export const MAX_STRICT_TRACKED_IDS = 1024;
export const MAX_STREAM_CANDIDATES = 10_000;
export const MAX_STREAM_DURATION_MS = 86_400_000;
export const fallbackOrderingTokens = new OrderingTokenSource();
export const ORDERING_TOKEN_RE = /^v1:(\d{13,}):([^:]+):(\d{6})$/;
export const FINISH_REASONS = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
]);
export const PROVIDER_METADATA_PARTS = new Set([
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
export const STREAM_PART_FIELDS: Readonly<Record<string, readonly string[]>> = {
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

export class AsyncStreamFieldError extends Error {}

export function streamField(value: object, key: string | number): unknown {
  const field = Reflect.get(value, key);
  if (consumeGenuinePromise(field)) {
    throw new AsyncStreamFieldError("async stream part fields are unsupported");
  }
  return field;
}

export function streamDiscriminant(
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

export function captureStreamSiblings(tasks: readonly (() => void)[]): void {
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

export const ASYNC_STREAM_FIELD = Symbol("async stream field");

export function captureStreamSiblingValue(
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

export function snapshotRecordFields(
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

export function snapshotStreamFinishReason(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const snapshot = snapshotRecordFields(value, undefined, ["raw", "unified"]);
  return { raw: snapshot.raw, unified: snapshot.unified };
}
