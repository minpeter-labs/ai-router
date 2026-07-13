import { AsyncFilePayloadError, snapshotFileData } from "./file-data";
import { snapshotJsonValue } from "./json-value";
import {
  consumeOwnDataPromiseFields,
  isUint8ArrayValue,
  isUrlValue,
} from "./runtime-types";

/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */

import {
  ASYNC_STREAM_FIELD,
  AsyncStreamFieldError,
  captureStreamSiblings,
  captureStreamSiblingValue,
  MAX_STREAM_WARNING_CHARS,
  MAX_STREAM_WARNINGS,
  snapshotRecordFields,
  streamDiscriminant,
  streamField,
} from "./stream-part-fields";
export interface StreamJsonBudget {
  remaining: number;
  remainingCharacters: number;
  remainingFileBytes: number;
  remainingMetadataCharacters: number;
}

export function snapshotStreamFileData(
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

export function snapshotStreamRequiredJson(
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

export function isOrdinaryJsonContainer(value: unknown): value is object {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

export function snapshotStreamRawValue(
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

export function snapshotStreamProviderMetadata(
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

export function snapshotStreamUsage(
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

export function snapshotStreamWarning(value: unknown): unknown {
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

export function streamWarningCharacters(value: unknown): number {
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

export function snapshotStreamWarnings(value: unknown): unknown {
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
