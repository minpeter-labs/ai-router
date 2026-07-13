import {
  AsyncFilePayloadError,
  MAX_FILE_PAYLOAD_BYTES,
  snapshotFileData,
} from "./file-data";
import {
  boundedEnumerableOwnKeys,
  isValidHttpHeaderName,
} from "./http-headers";
import { snapshotJsonValue } from "./json-value";
import { snapshotProviderBody } from "./provider-body";
import {
  MAX_GENERATE_JSON_CHARACTERS,
  MAX_GENERATE_JSON_CONTAINERS,
  MAX_RESULT_HEADER_CHARS,
  MAX_RESULT_HEADERS,
} from "./router-generate-validation";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  isDateValue,
} from "./runtime-types";

export function snapshotFinishReason(value: unknown): unknown {
  synchronousGenerateValue(value);
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return captureGenerateFields(value, ["raw", "unified"]);
}

export interface GenerateJsonBudget {
  remaining: number;
  remainingCharacters: number;
  remainingFileBytes: number;
}

export function createGenerateJsonBudget(): GenerateJsonBudget {
  return {
    remainingFileBytes: MAX_FILE_PAYLOAD_BYTES,
    remaining: MAX_GENERATE_JSON_CONTAINERS,
    remainingCharacters: MAX_GENERATE_JSON_CHARACTERS,
  };
}

export class AsyncGenerateFieldError extends Error {
  constructor() {
    super("async provider result fields are unsupported");
    this.name = "AsyncGenerateFieldError";
  }
}

export function synchronousGenerateValue(value: unknown): unknown {
  if (consumeGenuinePromise(value)) {
    throw new AsyncGenerateFieldError();
  }
  return value;
}

export function generateField(value: object, key: string | number): unknown {
  return synchronousGenerateValue(Reflect.get(value, key));
}

export function generateOpaqueField(
  value: object,
  key: string | number
): unknown {
  consumeOwnDataPromiseFields(value, [key]);
  const captured = Reflect.get(value, key);
  consumeGenuinePromise(captured);
  return captured;
}

export function generateDiscriminant(
  value: object,
  key: string,
  siblingKeys: readonly string[]
): unknown {
  consumeOwnDataPromiseFields(value, [key, ...siblingKeys]);
  try {
    return generateField(value, key);
  } catch (error) {
    if (error instanceof AsyncGenerateFieldError) {
      consumeOwnDataPromiseFields(value, siblingKeys);
    }
    throw error;
  }
}

export function captureGenerateFields(
  value: object,
  keys: readonly string[]
): Record<string, unknown> {
  consumeOwnDataPromiseFields(value, keys);
  const fields: Record<string, unknown> = {};
  let asyncFailure: AsyncGenerateFieldError | undefined;
  for (const key of keys) {
    try {
      fields[key] = generateField(value, key);
    } catch (error) {
      if (!(error instanceof AsyncGenerateFieldError)) {
        throw error;
      }
      asyncFailure ??= error;
    }
  }
  if (asyncFailure !== undefined) {
    throw asyncFailure;
  }
  return fields;
}

export function captureGenerateSiblings(tasks: readonly (() => void)[]): void {
  let asyncFailure: AsyncGenerateFieldError | undefined;
  for (const task of tasks) {
    try {
      task();
    } catch (error) {
      if (!(error instanceof AsyncGenerateFieldError)) {
        throw error;
      }
      asyncFailure ??= error;
    }
  }
  if (asyncFailure !== undefined) {
    throw asyncFailure;
  }
}

export const ASYNC_GENERATE_FIELD = Symbol("async generate field");

export function captureGenerateSiblingValue(
  task: () => unknown,
  failure: { error?: AsyncGenerateFieldError }
): unknown | typeof ASYNC_GENERATE_FIELD {
  try {
    return task();
  } catch (error) {
    if (!(error instanceof AsyncGenerateFieldError)) {
      throw error;
    }
    failure.error ??= error;
    return ASYNC_GENERATE_FIELD;
  }
}

export function snapshotRequiredJson(
  value: unknown,
  budget?: GenerateJsonBudget
): unknown {
  synchronousGenerateValue(value);
  const snapshot = snapshotJsonValue(
    value,
    budget?.remaining,
    budget?.remainingCharacters
  );
  if (!snapshot.valid) {
    if (snapshot.async) {
      throw new AsyncGenerateFieldError();
    }
    throw new Error("malformed provider JSON value");
  }
  if (budget !== undefined) {
    budget.remaining -= snapshot.containers ?? 0;
    budget.remainingCharacters -= snapshot.characters ?? 0;
  }
  return snapshot.value;
}

export function snapshotGenerateFileData(
  value: unknown,
  budget: GenerateJsonBudget
): unknown {
  try {
    return snapshotFileData(value, budget);
  } catch (error) {
    if (error instanceof AsyncFilePayloadError) {
      throw new AsyncGenerateFieldError();
    }
    throw error;
  }
}

export function snapshotProviderMetadata(
  value: unknown,
  budget?: GenerateJsonBudget
): unknown {
  if (value === undefined) {
    return;
  }
  const snapshot = snapshotRequiredJson(value, budget);
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  ) {
    throw new Error("malformed provider metadata");
  }
  return snapshot;
}

export function snapshotUsage(
  value: unknown,
  budget?: GenerateJsonBudget
): unknown {
  synchronousGenerateValue(value);
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const fields = captureGenerateFields(value, [
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
  captureGenerateSiblings([
    () => {
      if (typeof input === "object" && input !== null) {
        inputFields = captureGenerateFields(input, [
          "cacheRead",
          "cacheWrite",
          "noCache",
          "total",
        ]);
      }
    },
    () => {
      if (typeof output === "object" && output !== null) {
        outputFields = captureGenerateFields(output, [
          "reasoning",
          "text",
          "total",
        ]);
      }
    },
    () => {
      rawSnapshot =
        raw === undefined ? undefined : snapshotRequiredJson(raw, budget);
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

export function snapshotGenerateRequest(
  value: unknown,
  budget: GenerateJsonBudget
): unknown {
  synchronousGenerateValue(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const body = generateOpaqueField(value, "body");
  return {
    body: body === undefined ? undefined : snapshotProviderBody(body, budget),
  };
}

export function snapshotGenerateHeaders(value: unknown): unknown {
  synchronousGenerateValue(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const keys = boundedEnumerableOwnKeys(value, MAX_RESULT_HEADERS);
  // Use a safe malformed sentinel so a Proxy cannot change its ownKeys result
  // when the validator runs, and avoid reading oversized header accessors.
  if (keys === undefined) {
    return [];
  }
  consumeOwnDataPromiseFields(value, keys);
  if (keys.some((key) => !isValidHttpHeaderName(key))) {
    return [];
  }
  const snapshot: Record<string, unknown> = {};
  let totalChars = 0;
  let asyncFailure: AsyncGenerateFieldError | undefined;
  for (const key of keys) {
    let item: unknown;
    try {
      item = generateField(value, key);
    } catch (error) {
      if (!(error instanceof AsyncGenerateFieldError)) {
        throw error;
      }
      asyncFailure ??= error;
      continue;
    }
    if (typeof item === "string") {
      totalChars += key.length + item.length;
      if (totalChars > MAX_RESULT_HEADER_CHARS) {
        return [];
      }
    }
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  if (asyncFailure !== undefined) {
    throw asyncFailure;
  }
  return snapshot;
}

export function snapshotGenerateResponse(
  value: unknown,
  budget: GenerateJsonBudget
): unknown {
  synchronousGenerateValue(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  consumeOwnDataPromiseFields(value, ["body"]);
  const fields = captureGenerateFields(value, [
    "timestamp",
    "headers",
    "id",
    "modelId",
  ]);
  const timestamp = fields.timestamp;
  const body = generateOpaqueField(value, "body");
  let bodySnapshot: unknown;
  let headersSnapshot: unknown;
  captureGenerateSiblings([
    () => {
      bodySnapshot =
        body === undefined ? undefined : snapshotProviderBody(body, budget);
    },
    () => {
      headersSnapshot = snapshotGenerateHeaders(fields.headers);
    },
  ]);
  return {
    body: bodySnapshot,
    headers: headersSnapshot,
    id: fields.id,
    modelId: fields.modelId,
    timestamp: isDateValue(timestamp)
      ? new Date(Date.prototype.getTime.call(timestamp))
      : timestamp,
  };
}
