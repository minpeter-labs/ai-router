import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

import {
  AdmissionController,
  AdmissionRegistry,
  RouterConcurrencyError,
} from "./admission";
import { RetryBudget } from "./budget";
import { cloneCallOptions, cloneInitialCallOptions } from "./call-options";
import { CooldownState, resolveCooldown } from "./cooldown";
import { safeErrorProperty } from "./error-text";
import {
  defaultClassifyFailure,
  isTerminalRequestFailure,
  normalizeFailureClassification,
} from "./failure";
import {
  AsyncFilePayloadError,
  MAX_FILE_PAYLOAD_BYTES,
  snapshotFileData,
} from "./file-data";
import {
  CandidateHealthState,
  type HealthTransition,
  MemoryRouterHealthStore,
  RouterHealthUnavailableError,
} from "./health";
import {
  boundedEnumerableOwnKeys,
  hasInvalidHttpHeaderValueCharacter,
  isValidHttpHeaderName,
} from "./http-headers";
import { snapshotJsonValue } from "./json-value";
import { detectModalities, supportsAll } from "./modality";
import {
  runAttemptObservabilityHook,
  runErrorObservabilityHook,
} from "./observability";
import { OrderingTokenSource } from "./ordering";
import {
  recordFailure,
  resolveShouldRetry,
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
  isPlainObjectValue,
  isUint8ArrayValue,
  isUrlValue,
} from "./runtime-types";
import {
  discardLateStreamResult,
  type ResolvedEntry,
  wrapStreamResult,
} from "./stream";
import {
  clearTimerSafely,
  durationMs,
  effectiveTimeout,
  jitteredBackoff,
  monotonicNow,
  RouterTimeoutError,
  scheduleTimer,
  withTimeout,
} from "./timeout";
import type {
  ClassifyFailure,
  CreateRouterOptions,
  FailureClassification,
  FallbackOptions,
  Modality,
  OnRouterAttempt,
  OnRouterError,
  ProviderEntry,
  ProviderEntryFactory,
  ProviderEntryInstance,
  RetryBudgetConfig,
  Router,
  RouterAdmissionSnapshot,
  RouterHealthSnapshot,
  RouterHealthStore,
  RouterOrderingToken,
  RouterRetryBudgetSnapshot,
  ShouldRetryThisError,
  ValidateGenerateResult,
} from "./types";

/**
 * A candidate entry normalized to a single internal shape, regardless of which
 * of the three accepted `ProviderEntry` forms the user wrote.
 */
interface NormalizedEntry {
  adaptiveConcurrency?: boolean | import("./types").AdaptiveConcurrencyConfig;
  healthKey?: string;
  /** Model id for the fail-fast error message (factory form only). */
  label?: string;
  maxConcurrency?: number;
  /** The user's original entry — surfaced verbatim on `onError`. */
  original: ProviderEntry;
  providerFamily?: string;
  /** Produce the raw model (calls the factory, or returns the captured instance). */
  raw: () => LanguageModel;
  /** Declared modalities, or `undefined` for a universal (catch-all) candidate. */
  supports?: Modality[];
}

class EmptyModelResponseError extends Error {
  readonly code = "empty_model_response";

  constructor() {
    super("ai-router: provider returned an empty model response");
    this.name = "EmptyModelResponseError";
  }
}

class InvalidModelResponseError extends Error {
  readonly code = "invalid_model_response";

  constructor(message: string) {
    super(`ai-router: provider response rejected: ${message}`);
    this.name = "InvalidModelResponseError";
  }
}

class ValidatorContractError extends Error {
  readonly code = "validator_contract_error";

  constructor(message: string, cause?: unknown) {
    super(`ai-router: validateResult ${message}`, { cause });
    this.name = "ValidatorContractError";
  }
}

const CONTENT_TYPES = new Set([
  "text",
  "reasoning",
  "custom",
  "reasoning-file",
  "file",
  "tool-approval-request",
  "source",
  "tool-call",
  "tool-result",
]);
const FINISH_REASONS = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
]);
const MAX_GENERATE_CONTENT_PARTS = 10_000;
const MAX_GENERATE_JSON_CONTAINERS = 50_000;
const MAX_GENERATE_JSON_CHARACTERS = 4_194_304;
const MAX_GENERATE_METADATA_CHARACTERS = 4_194_304;
const MAX_METADATA_FIELD_LENGTH = 65_536;
const MAX_RESULT_WARNINGS = 1024;
const MAX_RESULT_WARNING_CHARS = 1_048_576;
const MAX_RESULT_WARNING_FIELD_LENGTH = 65_536;
const MAX_RESULT_HEADERS = 1024;
const MAX_RESULT_HEADER_LENGTH = 65_536;
const MAX_RESULT_HEADER_CHARS = 1_048_576;
const MAX_ROUTE_CANDIDATES = 10_000;
const MAX_LOGICAL_ROUTES = 10_000;
const MAX_TOTAL_ROUTE_CANDIDATES = 100_000;
const MAX_LOGICAL_ID_LENGTH = 256;

function validUsageNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function validOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function validOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function validWarningString(value: unknown): boolean {
  return (
    typeof value === "string" && value.length <= MAX_RESULT_WARNING_FIELD_LENGTH
  );
}

function validOptionalWarningString(value: unknown): boolean {
  return value === undefined || validWarningString(value);
}

function validWarning(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const warning = value as Record<string, unknown>;
  if (warning.type === "unsupported" || warning.type === "compatibility") {
    return (
      validWarningString(warning.feature) &&
      validOptionalWarningString(warning.details)
    );
  }
  if (warning.type === "deprecated") {
    return (
      validWarningString(warning.setting) && validWarningString(warning.message)
    );
  }
  return warning.type === "other" && validWarningString(warning.message);
}

function validResultHeaders(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = boundedEnumerableOwnKeys(value, MAX_RESULT_HEADERS);
  if (keys === undefined) {
    return false;
  }
  return keys.every((key) => {
    if (!isValidHttpHeaderName(key)) {
      return false;
    }
    const header = Reflect.get(value, key);
    return (
      typeof header === "string" &&
      header.length <= MAX_RESULT_HEADER_LENGTH &&
      !hasInvalidHttpHeaderValueCharacter(header)
    );
  });
}

function validGenerateMetadata(result: Record<string, unknown>): boolean {
  const providerMetadata = Reflect.get(result, "providerMetadata");
  if (
    providerMetadata !== undefined &&
    (typeof providerMetadata !== "object" ||
      providerMetadata === null ||
      Array.isArray(providerMetadata))
  ) {
    return false;
  }
  const request = Reflect.get(result, "request");
  if (request !== undefined) {
    if (
      typeof request !== "object" ||
      request === null ||
      Array.isArray(request)
    ) {
      return false;
    }
    Reflect.get(request, "body");
  }
  const response = Reflect.get(result, "response");
  if (response === undefined) {
    return true;
  }
  if (
    typeof response !== "object" ||
    response === null ||
    Array.isArray(response)
  ) {
    return false;
  }
  const id = Reflect.get(response, "id");
  const modelId = Reflect.get(response, "modelId");
  const timestamp = Reflect.get(response, "timestamp");
  Reflect.get(response, "body");
  return (
    (id === undefined || typeof id === "string") &&
    (modelId === undefined || typeof modelId === "string") &&
    (timestamp === undefined || isDateValue(timestamp)) &&
    validResultHeaders(Reflect.get(response, "headers"))
  );
}

function validateUsage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const usage = value as Record<string, unknown>;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (
    typeof input !== "object" ||
    input === null ||
    typeof output !== "object" ||
    output === null
  ) {
    return false;
  }
  const inputRecord = input as Record<string, unknown>;
  const outputRecord = output as Record<string, unknown>;
  return (
    ["total", "noCache", "cacheRead", "cacheWrite"].every((key) =>
      validUsageNumber(inputRecord[key])
    ) &&
    ["total", "text", "reasoning"].every((key) =>
      validUsageNumber(outputRecord[key])
    )
  );
}

function validGeneratedFileData(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (data.type === "data") {
    return typeof data.data === "string" || isUint8ArrayValue(data.data);
  }
  return data.type === "url" && isUrlValue(data.url);
}

function validContentPart(record: Record<string, unknown>): boolean {
  // Provider metadata is forwarded downstream. Trigger its accessor while the
  // result can still fall back instead of letting a hostile getter fail later
  // in the AI SDK after the candidate has been accepted.
  const providerMetadata = Reflect.get(record, "providerMetadata");
  if (
    providerMetadata !== undefined &&
    (typeof providerMetadata !== "object" ||
      providerMetadata === null ||
      Array.isArray(providerMetadata))
  ) {
    return false;
  }
  switch (record.type) {
    case "text":
    case "reasoning":
      return typeof record.text === "string";
    case "custom":
      return isDottedIdentifier(record.kind);
    case "file":
    case "reasoning-file":
      return (
        typeof record.mediaType === "string" &&
        validGeneratedFileData(record.data)
      );
    case "tool-approval-request":
      return (
        isBoundedIdentifier(record.approvalId) &&
        isBoundedIdentifier(record.toolCallId)
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
    default:
      return false;
  }
}

function validateContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return "content must be an array";
  }
  if (value.length > MAX_GENERATE_CONTENT_PARTS) {
    return `content exceeds ${MAX_GENERATE_CONTENT_PARTS} parts`;
  }
  const toolCallIds = new Set<string>();
  for (const part of value) {
    const type =
      typeof part === "object" && part !== null
        ? (part as Record<string, unknown>).type
        : undefined;
    if (
      typeof part !== "object" ||
      part === null ||
      typeof type !== "string" ||
      !CONTENT_TYPES.has(type) ||
      !validContentPart(part as Record<string, unknown>)
    ) {
      return "content contains an unknown or malformed part";
    }
    const record = part as Record<string, unknown>;
    if (record.type === "tool-call") {
      const id = record.toolCallId as string;
      if (toolCallIds.has(id)) {
        return "content contains duplicate tool-call ids";
      }
      toolCallIds.add(id);
    }
  }
  return;
}

function validateGenerateEnvelope(value: unknown): string | undefined {
  try {
    if (typeof value !== "object" || value === null) {
      return "result must be an object";
    }
    const result = value as Record<string, unknown>;
    const contentError = validateContent(result.content);
    if (contentError !== undefined) {
      return contentError;
    }
    const finishReason = result.finishReason;
    if (typeof finishReason !== "object" || finishReason === null) {
      return "finishReason must be an object";
    }
    const finish = finishReason as Record<string, unknown>;
    if (
      !(
        typeof finish.unified === "string" &&
        FINISH_REASONS.has(finish.unified) &&
        (finish.raw === undefined || typeof finish.raw === "string")
      )
    ) {
      return "finishReason is malformed";
    }
    if (!validateUsage(result.usage)) {
      return "usage is malformed";
    }
    if (!Array.isArray(result.warnings)) {
      return "warnings are malformed";
    }
    if (result.warnings.length > MAX_RESULT_WARNINGS) {
      return `warnings exceed ${MAX_RESULT_WARNINGS} entries`;
    }
    if (
      !(isDenseArray(result.warnings) && result.warnings.every(validWarning))
    ) {
      return "warnings are malformed";
    }
    if (!validGenerateMetadata(result)) {
      return "optional metadata is malformed";
    }
    return;
  } catch {
    return "result properties could not be read";
  }
}

function snapshotFinishReason(value: unknown): unknown {
  synchronousGenerateValue(value);
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return captureGenerateFields(value, ["raw", "unified"]);
}

interface GenerateJsonBudget {
  remaining: number;
  remainingCharacters: number;
  remainingFileBytes: number;
}

function createGenerateJsonBudget(): GenerateJsonBudget {
  return {
    remainingFileBytes: MAX_FILE_PAYLOAD_BYTES,
    remaining: MAX_GENERATE_JSON_CONTAINERS,
    remainingCharacters: MAX_GENERATE_JSON_CHARACTERS,
  };
}

class AsyncGenerateFieldError extends Error {
  constructor() {
    super("async provider result fields are unsupported");
    this.name = "AsyncGenerateFieldError";
  }
}

function synchronousGenerateValue(value: unknown): unknown {
  if (consumeGenuinePromise(value)) {
    throw new AsyncGenerateFieldError();
  }
  return value;
}

function generateField(value: object, key: string | number): unknown {
  return synchronousGenerateValue(Reflect.get(value, key));
}

function generateDiscriminant(
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

function captureGenerateFields(
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

function captureGenerateSiblings(tasks: readonly (() => void)[]): void {
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

const ASYNC_GENERATE_FIELD = Symbol("async generate field");

function captureGenerateSiblingValue(
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

function snapshotRequiredJson(
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

function snapshotGenerateFileData(
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

function snapshotProviderMetadata(
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

function snapshotUsage(value: unknown, budget?: GenerateJsonBudget): unknown {
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

function snapshotGenerateRequest(
  value: unknown,
  budget: GenerateJsonBudget
): unknown {
  synchronousGenerateValue(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const body = generateField(value, "body");
  return {
    body: body === undefined ? undefined : snapshotRequiredJson(body, budget),
  };
}

function snapshotGenerateHeaders(value: unknown): unknown {
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

function snapshotGenerateResponse(
  value: unknown,
  budget: GenerateJsonBudget
): unknown {
  synchronousGenerateValue(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const fields = captureGenerateFields(value, [
    "timestamp",
    "body",
    "headers",
    "id",
    "modelId",
  ]);
  const timestamp = fields.timestamp;
  const body = fields.body;
  let bodySnapshot: unknown;
  let headersSnapshot: unknown;
  captureGenerateSiblings([
    () => {
      bodySnapshot =
        body === undefined ? undefined : snapshotRequiredJson(body, budget);
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

function snapshotContentPart(
  value: unknown,
  budget: GenerateJsonBudget
): unknown {
  synchronousGenerateValue(value);
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const type = generateDiscriminant(value, "type", [
    "approvalId",
    "data",
    "dynamic",
    "filename",
    "id",
    "input",
    "isError",
    "kind",
    "mediaType",
    "preliminary",
    "providerExecuted",
    "providerMetadata",
    "result",
    "sourceType",
    "text",
    "title",
    "toolCallId",
    "toolName",
    "url",
  ]);
  const keys = (() => {
    switch (type) {
      case "text":
      case "reasoning":
        return ["providerMetadata", "text"];
      case "custom":
        return ["kind", "providerMetadata"];
      case "file":
      case "reasoning-file":
        return ["data", "mediaType", "providerMetadata"];
      case "tool-approval-request":
        return ["approvalId", "providerMetadata", "toolCallId"];
      case "tool-call":
        return [
          "dynamic",
          "input",
          "providerExecuted",
          "providerMetadata",
          "toolCallId",
          "toolName",
        ];
      case "tool-result":
        return [
          "dynamic",
          "isError",
          "preliminary",
          "providerMetadata",
          "result",
          "toolCallId",
          "toolName",
        ];
      case "source":
        return ["providerMetadata", "sourceType"];
      default:
        return ["providerMetadata"];
    }
  })();
  const fields = captureGenerateFields(value, keys);
  let providerMetadata: unknown;
  let fileData: unknown;
  let toolResult: unknown;
  let sourceFields: Record<string, unknown> | undefined;
  const transformations: (() => void)[] = [
    () => {
      providerMetadata = snapshotProviderMetadata(
        fields.providerMetadata,
        budget
      );
    },
  ];
  if (type === "file" || type === "reasoning-file") {
    transformations.push(() => {
      fileData = snapshotGenerateFileData(fields.data, budget);
    });
  } else if (type === "tool-result") {
    transformations.push(() => {
      toolResult = snapshotRequiredJson(fields.result, budget);
    });
  } else if (type === "source") {
    transformations.push(() => {
      sourceFields =
        fields.sourceType === "url"
          ? captureGenerateFields(value, ["id", "title", "url"])
          : captureGenerateFields(value, [
              "filename",
              "id",
              "mediaType",
              "title",
            ]);
    });
  }
  captureGenerateSiblings(transformations);
  switch (type) {
    case "text":
    case "reasoning":
      return { providerMetadata, text: fields.text, type };
    case "custom":
      return { kind: fields.kind, providerMetadata, type };
    case "file":
    case "reasoning-file":
      return {
        data: fileData,
        mediaType: fields.mediaType,
        providerMetadata,
        type,
      };
    case "tool-approval-request":
      return {
        approvalId: fields.approvalId,
        providerMetadata,
        toolCallId: fields.toolCallId,
        type,
      };
    case "tool-call":
      return {
        dynamic: fields.dynamic,
        input: fields.input,
        providerExecuted: fields.providerExecuted,
        providerMetadata,
        toolCallId: fields.toolCallId,
        toolName: fields.toolName,
        type,
      };
    case "tool-result":
      return {
        dynamic: fields.dynamic,
        isError: fields.isError,
        preliminary: fields.preliminary,
        providerMetadata,
        result: toolResult,
        toolCallId: fields.toolCallId,
        toolName: fields.toolName,
        type,
      };
    case "source": {
      const sourceType = fields.sourceType;
      if (sourceFields === undefined) {
        throw new Error("source fields are unavailable");
      }
      if (sourceType === "url") {
        return {
          id: sourceFields.id,
          providerMetadata,
          sourceType,
          title: sourceFields.title,
          type,
          url: sourceFields.url,
        };
      }
      return {
        filename: sourceFields.filename,
        id: sourceFields.id,
        mediaType: sourceFields.mediaType,
        providerMetadata,
        sourceType,
        title: sourceFields.title,
        type,
      };
    }
    default:
      return { providerMetadata, type };
  }
}

function snapshotGenerateContent(
  value: unknown,
  budget: GenerateJsonBudget
): unknown {
  synchronousGenerateValue(value);
  if (!Array.isArray(value)) {
    return value;
  }
  const length = generateField(value, "length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_GENERATE_CONTENT_PARTS
  ) {
    return new Array(MAX_GENERATE_CONTENT_PARTS + 1);
  }
  consumeOwnDataPromiseFields(
    value,
    Array.from({ length }, (_, index) => index)
  );
  const snapshot = new Array<unknown>(length);
  const failure: { error?: AsyncGenerateFieldError } = {};
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return new Array(length);
    }
    const part = captureGenerateSiblingValue(
      () => snapshotContentPart(generateField(value, index), budget),
      failure
    );
    if (part !== ASYNC_GENERATE_FIELD) {
      snapshot[index] = part;
    }
  }
  if (failure.error !== undefined) {
    throw failure.error;
  }
  return snapshot;
}

function snapshotGenerateWarning(value: unknown): unknown {
  synchronousGenerateValue(value);
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const type = generateDiscriminant(value, "type", [
    "details",
    "feature",
    "message",
    "setting",
  ]);
  if (type === "unsupported" || type === "compatibility") {
    const fields = captureGenerateFields(value, ["details", "feature"]);
    return {
      details: fields.details,
      feature: fields.feature,
      type,
    };
  }
  if (type === "deprecated") {
    const fields = captureGenerateFields(value, ["message", "setting"]);
    return {
      message: fields.message,
      setting: fields.setting,
      type,
    };
  }
  return { message: generateField(value, "message"), type };
}

function generateWarningCharacters(value: unknown): number {
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

function snapshotGenerateWarnings(value: unknown): unknown {
  synchronousGenerateValue(value);
  if (!Array.isArray(value)) {
    return value;
  }
  const length = generateField(value, "length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_RESULT_WARNINGS
  ) {
    return new Array(MAX_RESULT_WARNINGS + 1);
  }
  consumeOwnDataPromiseFields(
    value,
    Array.from({ length }, (_, index) => index)
  );
  const snapshot = new Array<unknown>(length);
  let totalChars = 0;
  const failure: { error?: AsyncGenerateFieldError } = {};
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return new Array(length);
    }
    const warning = captureGenerateSiblingValue(
      () => snapshotGenerateWarning(generateField(value, index)),
      failure
    );
    if (warning === ASYNC_GENERATE_FIELD) {
      continue;
    }
    snapshot[index] = warning;
    totalChars += generateWarningCharacters(warning);
    if (totalChars > MAX_RESULT_WARNING_CHARS) {
      return [null];
    }
  }
  if (failure.error !== undefined) {
    throw failure.error;
  }
  return snapshot;
}

function validateGenerateMetadataStrings(
  result: LanguageModelV4GenerateResult
): void {
  let remaining = MAX_GENERATE_METADATA_CHARACTERS;
  const consume = (
    value: unknown,
    maximum = MAX_METADATA_FIELD_LENGTH,
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
      throw new Error(
        "generate metadata strings must be non-empty and bounded"
      );
    }
    remaining -= value.length;
    if (remaining < 0) {
      throw new Error("generate metadata exceeds the aggregate string limit");
    }
  };
  consume(result.finishReason.raw);
  consume(result.response?.id, 4096);
  consume(result.response?.modelId, 4096);
  for (const part of result.content) {
    const record = part as unknown as Record<string, unknown>;
    switch (part.type) {
      case "file":
      case "reasoning-file":
        consume(record.mediaType, 256, false);
        break;
      case "custom":
        consume(record.kind, 4096);
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
      case "source":
        consume(record.id, 4096);
        consume(record.url);
        consume(record.title);
        consume(record.mediaType, 256, false);
        consume(record.filename);
        break;
      default:
        break;
    }
  }
}

function snapshotGenerateEnvelope(
  value: LanguageModelV4GenerateResult
): LanguageModelV4GenerateResult {
  const record = value as unknown as Record<string, unknown>;
  const fields = captureGenerateFields(record, GENERATE_ENVELOPE_FIELDS);
  const budget = createGenerateJsonBudget();
  const snapshot = {} as LanguageModelV4GenerateResult;
  captureGenerateSiblings([
    () => {
      snapshot.content = snapshotGenerateContent(
        fields.content,
        budget
      ) as LanguageModelV4GenerateResult["content"];
    },
    () => {
      snapshot.finishReason = snapshotFinishReason(
        fields.finishReason
      ) as LanguageModelV4GenerateResult["finishReason"];
    },
    () => {
      snapshot.providerMetadata = snapshotProviderMetadata(
        fields.providerMetadata,
        budget
      ) as LanguageModelV4GenerateResult["providerMetadata"];
    },
    () => {
      snapshot.request = snapshotGenerateRequest(
        fields.request,
        budget
      ) as LanguageModelV4GenerateResult["request"];
    },
    () => {
      snapshot.response = snapshotGenerateResponse(
        fields.response,
        budget
      ) as LanguageModelV4GenerateResult["response"];
    },
    () => {
      snapshot.usage = snapshotUsage(
        fields.usage,
        budget
      ) as LanguageModelV4GenerateResult["usage"];
    },
    () => {
      snapshot.warnings = snapshotGenerateWarnings(
        fields.warnings
      ) as LanguageModelV4GenerateResult["warnings"];
    },
  ]);
  validateGenerateMetadataStrings(snapshot);
  return snapshot;
}

function discardLateGenerateResult(
  result: LanguageModelV4GenerateResult
): void {
  const record = result as unknown as Record<string, unknown>;
  consumeOwnDataPromiseFields(record, GENERATE_ENVELOPE_FIELDS);
  const cleanups = [
    () =>
      snapshotGenerateContent(
        Reflect.get(record, "content"),
        createGenerateJsonBudget()
      ),
    () => snapshotFinishReason(Reflect.get(record, "finishReason")),
    () =>
      snapshotProviderMetadata(
        Reflect.get(record, "providerMetadata"),
        createGenerateJsonBudget()
      ),
    () =>
      snapshotGenerateRequest(
        Reflect.get(record, "request"),
        createGenerateJsonBudget()
      ),
    () =>
      snapshotGenerateResponse(
        Reflect.get(record, "response"),
        createGenerateJsonBudget()
      ),
    () =>
      snapshotUsage(Reflect.get(record, "usage"), createGenerateJsonBudget()),
    () => snapshotGenerateWarnings(Reflect.get(record, "warnings")),
  ];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Late-result fields are independent best-effort cleanup boundaries.
    }
  }
}

const GENERATE_ENVELOPE_FIELDS = [
  "content",
  "finishReason",
  "providerMetadata",
  "request",
  "response",
  "usage",
  "warnings",
] as const;

const GENERATE_CONTENT_MUTATION_FIELDS = [
  "approvalId",
  "data",
  "dynamic",
  "filename",
  "id",
  "input",
  "isError",
  "kind",
  "mediaType",
  "preliminary",
  "providerExecuted",
  "providerMetadata",
  "result",
  "sourceType",
  "text",
  "title",
  "toolCallId",
  "toolName",
  "type",
  "url",
] as const;
const MAX_VALIDATOR_MUTATION_FIELDS = 200_000;

interface ValidatorMutationTarget {
  keys: string[];
  value: object;
}

function validatorMutationKeys(
  value: object,
  remainingFields: number
): string[] | undefined {
  try {
    if (Array.isArray(value)) {
      const length = validatorOwnDataValue(value, "length");
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > remainingFields
      ) {
        return;
      }
      return Array.from({ length }, (_, index) => String(index));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return;
    }
    const keys = Object.keys(value);
    return keys.length <= remainingFields ? keys : undefined;
  } catch {
    return;
  }
}

function validatorOwnDataValue(value: object, key: string | number): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return;
  }
}

function consumeValidatorArrayItemPromises(
  value: unknown,
  maximum: number,
  itemFields: readonly string[]
): void {
  if (!Array.isArray(value)) {
    return;
  }
  const length = validatorOwnDataValue(value, "length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum
  ) {
    return;
  }
  for (let index = 0; index < length; index += 1) {
    const item = validatorOwnDataValue(value, index);
    if (consumeGenuinePromise(item)) {
      continue;
    }
    if (typeof item === "object" && item !== null) {
      consumeOwnDataPromiseFields(item, itemFields);
    }
  }
}

function consumeNestedValidatorInputPromiseMutations(
  input: LanguageModelV4GenerateResult
): void {
  consumeValidatorArrayItemPromises(
    validatorOwnDataValue(input, "content"),
    MAX_GENERATE_CONTENT_PARTS,
    GENERATE_CONTENT_MUTATION_FIELDS
  );
  consumeValidatorArrayItemPromises(
    validatorOwnDataValue(input, "warnings"),
    MAX_RESULT_WARNINGS,
    ["details", "feature", "message", "setting", "type"]
  );
  const finishReason = validatorOwnDataValue(input, "finishReason");
  if (typeof finishReason === "object" && finishReason !== null) {
    consumeOwnDataPromiseFields(finishReason, ["raw", "unified"]);
  }
  const request = validatorOwnDataValue(input, "request");
  if (typeof request === "object" && request !== null) {
    consumeOwnDataPromiseFields(request, ["body"]);
  }
  const response = validatorOwnDataValue(input, "response");
  if (typeof response === "object" && response !== null) {
    consumeOwnDataPromiseFields(response, [
      "body",
      "headers",
      "id",
      "modelId",
      "timestamp",
    ]);
  }
  const usage = validatorOwnDataValue(input, "usage");
  if (typeof usage === "object" && usage !== null) {
    consumeOwnDataPromiseFields(usage, ["inputTokens", "outputTokens", "raw"]);
    const inputTokens = validatorOwnDataValue(usage, "inputTokens");
    if (typeof inputTokens === "object" && inputTokens !== null) {
      consumeOwnDataPromiseFields(inputTokens, [
        "cacheRead",
        "cacheWrite",
        "noCache",
        "total",
      ]);
    }
    const outputTokens = validatorOwnDataValue(usage, "outputTokens");
    if (typeof outputTokens === "object" && outputTokens !== null) {
      consumeOwnDataPromiseFields(outputTokens, ["reasoning", "text", "total"]);
    }
  }
}

function captureValidatorMutationTargets(
  root: LanguageModelV4GenerateResult
): ValidatorMutationTarget[] {
  const targets: ValidatorMutationTarget[] = [];
  const pending: object[] = [root];
  const seen = new WeakSet<object>();
  let remainingFields = MAX_VALIDATOR_MUTATION_FIELDS;
  while (pending.length > 0 && remainingFields > 0) {
    const value = pending.pop();
    if (value === undefined || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const keys = validatorMutationKeys(value, remainingFields);
    if (keys === undefined) {
      continue;
    }
    remainingFields -= keys.length;
    targets.push({ keys, value });
    for (const key of keys) {
      const item = validatorOwnDataValue(value, key);
      if (typeof item === "object" && item !== null) {
        pending.push(item);
      }
    }
  }
  return targets;
}

function consumeCapturedValidatorMutationPromises(
  targets: ValidatorMutationTarget[]
): void {
  for (const target of targets) {
    consumeOwnDataPromiseFields(target.value, target.keys);
  }
}

class InvalidProviderModelError extends Error {
  readonly code = "invalid_provider_model";

  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderModelError";
  }
}

/** A successful generate call must contain something usable by the caller. */
function hasOutputContent(result: LanguageModelV4GenerateResult): boolean {
  return result.content.some((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return part.text.trim().length > 0;
    }
    // Tool calls and future non-text output types are meaningful payloads.
    return true;
  });
}

function validateAdaptiveConcurrency(entry: NormalizedEntry): void {
  const value = entry.adaptiveConcurrency;
  if (value === undefined || value === false || value === true) {
    return;
  }
  if (!isPlainObjectValue(value)) {
    throw new Error(
      "ai-router: adaptiveConcurrency must be a boolean or config object"
    );
  }
  const min = value.min ?? 1;
  const max = value.max ?? Math.max(entry.maxConcurrency ?? 1, 16);
  const initial = value.initial ?? entry.maxConcurrency ?? min;
  const increase = value.increaseAfterSuccesses ?? 10;
  if (
    ![min, max, initial, increase].every(
      (item) => Number.isSafeInteger(item) && item > 0
    ) ||
    min > initial ||
    initial > max
  ) {
    throw new Error(
      "ai-router: adaptiveConcurrency requires positive integers with min <= initial <= max"
    );
  }
}

const VALID_MODALITIES = new Set<Modality>([
  "text",
  "image",
  "video",
  "audio",
  "pdf",
  "file",
]);
const MAX_HEALTH_IDENTITY_LENGTH = 256;

function validateHealthIdentity(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`ai-router: ${name} must not be empty`);
  }
  if (value.length > MAX_HEALTH_IDENTITY_LENGTH) {
    throw new Error(
      `ai-router: ${name} must be at most ${MAX_HEALTH_IDENTITY_LENGTH} characters`
    );
  }
}

function validateEntryConfiguration(entry: NormalizedEntry): void {
  validateAdaptiveConcurrency(entry);
  if (entry.healthKey !== undefined && typeof entry.healthKey !== "string") {
    throw new Error("ai-router: healthKey must be a string");
  }
  if (
    entry.providerFamily !== undefined &&
    typeof entry.providerFamily !== "string"
  ) {
    throw new Error("ai-router: providerFamily must be a string");
  }
  if (entry.healthKey !== undefined) {
    validateHealthIdentity(entry.healthKey, "healthKey");
  }
  if (entry.providerFamily !== undefined) {
    validateHealthIdentity(entry.providerFamily, "providerFamily");
  }
  if (
    entry.supports !== undefined &&
    !(
      Array.isArray(entry.supports) &&
      entry.supports.length <= VALID_MODALITIES.size &&
      isDenseArray(entry.supports) &&
      entry.supports.every((modality) => VALID_MODALITIES.has(modality))
    )
  ) {
    throw new Error("ai-router: supports contains an unknown modality");
  }
}

function admissionSignature(entry: NormalizedEntry): string {
  if (
    entry.adaptiveConcurrency === undefined ||
    entry.adaptiveConcurrency === false
  ) {
    return `fixed:${entry.maxConcurrency ?? "unbounded"}`;
  }
  const config =
    typeof entry.adaptiveConcurrency === "object"
      ? entry.adaptiveConcurrency
      : {};
  const min = config.min ?? 1;
  const max = config.max ?? Math.max(entry.maxConcurrency ?? 1, 16);
  return [
    "adaptive",
    config.initial ?? entry.maxConcurrency ?? min,
    min,
    max,
    config.increaseAfterSuccesses ?? 10,
  ].join(":");
}

function validateSharedAdmission(entries: NormalizedEntry[]): void {
  const signatures = new Map<string, string>();
  for (const entry of entries) {
    if (entry.healthKey === undefined) {
      continue;
    }
    const signature = admissionSignature(entry);
    const existing = signatures.get(entry.healthKey);
    if (existing !== undefined && existing !== signature) {
      throw new Error(
        `ai-router: candidates sharing healthKey "${entry.healthKey}" must use identical concurrency settings`
      );
    }
    signatures.set(entry.healthKey, signature);
  }
}

function resolveHealthNamespace(
  logicalId: string,
  namespace: string | undefined
): string {
  if (namespace !== undefined) {
    if (typeof namespace !== "string") {
      throw new Error("ai-router: healthNamespace must be a string");
    }
    validateHealthIdentity(namespace, "healthNamespace");
  }
  const logicalSegment = encodeURIComponent(logicalId);
  return namespace === undefined
    ? `logical:${logicalSegment}`
    : `scoped:${encodeURIComponent(namespace)}:${logicalSegment}`;
}

function resolveSharedHealthNamespace(
  logicalId: string,
  namespace: string | undefined
): string {
  return namespace === undefined
    ? `logical:${encodeURIComponent(logicalId)}`
    : `scope:${encodeURIComponent(namespace)}`;
}

function createOrderingTokenSource(): OrderingTokenSource {
  return new OrderingTokenSource();
}

const orderingSources = new WeakMap<RouterHealthStore, OrderingTokenSource>();

function orderingTokenSourceFor(
  healthStore: RouterHealthStore
): OrderingTokenSource {
  const existing = orderingSources.get(healthStore);
  if (existing !== undefined) {
    return existing;
  }
  const source = createOrderingTokenSource();
  orderingSources.set(healthStore, source);
  return source;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  try {
    const aborted = signal?.aborted;
    return !consumeGenuinePromise(aborted) && aborted === true;
  } catch {
    // An unreadable synthetic signal cannot prove that cancellation occurred.
    return false;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!isSignalAborted(signal)) {
    return;
  }
  let reason: unknown;
  try {
    reason = signal?.reason;
    if (consumeGenuinePromise(reason)) {
      throw new DOMException("aborted", "AbortError");
    }
  } catch {
    // Accessing a hostile reason may itself throw. Preserve cancellation with
    // a stable AbortError instead of leaking the accessor failure.
    throw new DOMException("aborted", "AbortError");
  }
  throw reason ?? new DOMException("aborted", "AbortError");
}

function createRetryBudget(
  config: boolean | RetryBudgetConfig | undefined
): RetryBudget | undefined {
  if (config === undefined || config === false) {
    return;
  }
  if (config === true) {
    return new RetryBudget();
  }
  if (consumeGenuinePromise(config)) {
    throw new Error("ai-router: retryBudget must be synchronous");
  }
  if (!isPlainObjectValue(config)) {
    throw new Error(
      "ai-router: retryBudget must be a boolean or config object"
    );
  }
  const keys = [
    "maxSamples",
    "minSamples",
    "recoveryFailureRate",
    "tripFailureRate",
    "window",
  ] as const;
  consumeOwnDataPromiseFields(config, keys);
  const snapshot = {
    maxSamples: config.maxSamples,
    minSamples: config.minSamples,
    recoveryFailureRate: config.recoveryFailureRate,
    tripFailureRate: config.tripFailureRate,
    window: config.window,
  };
  for (const field of Object.values(snapshot)) {
    if (consumeGenuinePromise(field)) {
      throw new Error("ai-router: retryBudget must be synchronous");
    }
  }
  return new RetryBudget(
    Date.now,
    durationMs(snapshot.window as RetryBudgetConfig["window"]) ?? 60_000,
    snapshot as RetryBudgetConfig
  );
}

const STABLE_MODELS = new WeakSet<object>();

/** Snapshot callable model operations once while preserving their original `this`. */
function snapshotLanguageModelV4(value: unknown): LanguageModelV4 | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (STABLE_MODELS.has(value)) {
    return value as LanguageModelV4;
  }
  if (consumeGenuinePromise(value)) {
    return;
  }
  consumeOwnDataPromiseFields(value, [
    "doGenerate",
    "doStream",
    "modelId",
    "provider",
    "specificationVersion",
  ]);
  // Accessor throws are intentionally allowed to escape: unlike a stable
  // non-v4 shape, a factory/model getter failure can be transient and must not
  // be memoized in the permanent invalid-model cache.
  const specificationVersion = Reflect.get(value, "specificationVersion");
  if (
    consumeGenuinePromise(specificationVersion) ||
    specificationVersion !== "v4"
  ) {
    return;
  }
  const doGenerate = Reflect.get(value, "doGenerate");
  const doStream = Reflect.get(value, "doStream");
  const modelId = Reflect.get(value, "modelId", value);
  const provider = Reflect.get(value, "provider", value);
  let asyncRequiredSlot = false;
  for (const slot of [doGenerate, doStream, modelId, provider]) {
    if (consumeGenuinePromise(slot)) {
      asyncRequiredSlot = true;
    }
  }
  if (
    asyncRequiredSlot ||
    typeof doGenerate !== "function" ||
    typeof doStream !== "function" ||
    (modelId !== undefined && typeof modelId !== "string") ||
    (provider !== undefined && typeof provider !== "string")
  ) {
    return;
  }
  let supportedUrls: LanguageModelV4["supportedUrls"];
  let supportedUrlsRead = false;
  const model: LanguageModelV4 = {
    doGenerate: (options) => Reflect.apply(doGenerate, value, [options]),
    doStream: (options) => Reflect.apply(doStream, value, [options]),
    modelId: modelId as string,
    provider: provider as string,
    specificationVersion: "v4",
    get supportedUrls() {
      if (!supportedUrlsRead) {
        supportedUrlsRead = true;
        try {
          supportedUrls = Reflect.get(value, "supportedUrls", value);
        } catch {
          supportedUrls = {};
        }
      }
      return supportedUrls;
    },
  };
  STABLE_MODELS.add(model);
  return model;
}

function snapshotAdaptiveConcurrency(
  value: unknown
): NormalizedEntry["adaptiveConcurrency"] {
  if (consumeGenuinePromise(value)) {
    throw new Error("ai-router: adaptiveConcurrency must be synchronous");
  }
  if (!isPlainObjectValue(value)) {
    return value as NormalizedEntry["adaptiveConcurrency"];
  }
  const config = value as import("./types").AdaptiveConcurrencyConfig;
  const keys = ["increaseAfterSuccesses", "initial", "max", "min"] as const;
  consumeOwnDataPromiseFields(config, keys);
  const snapshot = {
    increaseAfterSuccesses: config.increaseAfterSuccesses,
    initial: config.initial,
    max: config.max,
    min: config.min,
  };
  let asyncField = false;
  for (const field of Object.values(snapshot)) {
    if (consumeGenuinePromise(field)) {
      asyncField = true;
    }
  }
  if (asyncField) {
    throw new Error("ai-router: adaptiveConcurrency must be synchronous");
  }
  return snapshot;
}

function snapshotSupports(value: unknown): Modality[] | undefined {
  if (value === undefined) {
    return;
  }
  if (consumeGenuinePromise(value)) {
    throw new Error("ai-router: supports must be synchronous");
  }
  if (!Array.isArray(value)) {
    throw new Error("ai-router: supports contains an unknown modality");
  }
  let length: number;
  try {
    length = Reflect.get(value, "length");
  } catch {
    throw new Error("ai-router: supports contains an unknown modality");
  }
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > VALID_MODALITIES.size
  ) {
    throw new Error("ai-router: supports contains an unknown modality");
  }
  consumeOwnDataPromiseFields(
    value,
    Array.from({ length }, (_, index) => index)
  );
  const snapshot: Modality[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error("ai-router: supports contains an unknown modality");
    }
    let modality: unknown;
    try {
      modality = Reflect.get(value, index);
    } catch {
      throw new Error("ai-router: supports contains an unknown modality");
    }
    if (!VALID_MODALITIES.has(modality as Modality)) {
      throw new Error("ai-router: supports contains an unknown modality");
    }
    snapshot.push(modality as Modality);
  }
  return snapshot;
}

const capturedHealthStores = new WeakMap<object, RouterHealthStore>();

function captureHealthStore(store: unknown): RouterHealthStore {
  if (
    !(
      (typeof store === "object" && store !== null) ||
      typeof store === "function"
    )
  ) {
    throw new Error("ai-router: fallback.healthStore must be an object");
  }
  const storeObject = store as object;
  const existing = capturedHealthStores.get(storeObject);
  if (existing !== undefined) {
    return existing;
  }
  const methodNames = [
    "compareAndSet",
    "delete",
    "entries",
    "get",
    "set",
  ] as const;
  consumeOwnDataPromiseFields(storeObject, methodNames);
  const methods = {
    compareAndSet: safeErrorProperty(store, "compareAndSet"),
    delete: safeErrorProperty(store, "delete"),
    entries: safeErrorProperty(store, "entries"),
    get: safeErrorProperty(store, "get"),
    set: safeErrorProperty(store, "set"),
  };
  let asyncMethod = false;
  for (const method of Object.values(methods)) {
    if (consumeGenuinePromise(method)) {
      asyncMethod = true;
    }
  }
  if (asyncMethod) {
    throw new Error(
      "ai-router: fallback.healthStore methods must be synchronous"
    );
  }
  for (const method of ["delete", "get", "set"] as const) {
    if (typeof methods[method] !== "function") {
      throw new Error(
        `ai-router: fallback.healthStore.${method} must be a function`
      );
    }
  }
  for (const method of ["compareAndSet", "entries"] as const) {
    const value = methods[method];
    if (value !== undefined && typeof value !== "function") {
      throw new Error(
        `ai-router: fallback.healthStore.${method} must be a function`
      );
    }
  }
  const deleteMethod = methods.delete as RouterHealthStore["delete"];
  const getMethod = methods.get as RouterHealthStore["get"];
  const setMethod = methods.set as RouterHealthStore["set"];
  const captured: RouterHealthStore = {
    delete(key) {
      return deleteMethod.call(store, key);
    },
    get(key) {
      return getMethod.call(store, key);
    },
    set(key, value) {
      return setMethod.call(store, key, value);
    },
  };
  if (typeof methods.compareAndSet === "function") {
    const compareAndSetMethod = methods.compareAndSet as NonNullable<
      RouterHealthStore["compareAndSet"]
    >;
    captured.compareAndSet = (key, expectedVersion, value) =>
      compareAndSetMethod.call(store, key, expectedVersion, value);
  }
  if (typeof methods.entries === "function") {
    const entriesMethod = methods.entries as NonNullable<
      RouterHealthStore["entries"]
    >;
    captured.entries = () => entriesMethod.call(store);
  }
  capturedHealthStores.set(storeObject, captured);
  return captured;
}

function snapshotFallback(
  fallback: FallbackOptions | undefined
): FallbackOptions | undefined {
  if (fallback === undefined) {
    return;
  }
  if (consumeGenuinePromise(fallback)) {
    throw new Error("ai-router: fallback must be synchronous");
  }
  if (
    typeof fallback !== "object" ||
    fallback === null ||
    Array.isArray(fallback)
  ) {
    throw new Error("ai-router: fallback must be an options object");
  }
  const keys = [
    "attemptTimeout",
    "backoff",
    "classifyFailure",
    "concurrencyWaitTimeout",
    "cooldown",
    "firstContentTimeout",
    "health",
    "healthNamespace",
    "healthStore",
    "maxAttempts",
    "retryAfterOutput",
    "retryBudget",
    "selection",
    "shouldRetry",
    "strictStreamValidation",
    "totalTimeout",
    "validateResult",
  ] as const;
  consumeOwnDataPromiseFields(fallback, keys);
  const snapshot: FallbackOptions = {
    attemptTimeout: fallback.attemptTimeout,
    backoff: fallback.backoff,
    classifyFailure: fallback.classifyFailure,
    concurrencyWaitTimeout: fallback.concurrencyWaitTimeout,
    cooldown: fallback.cooldown,
    firstContentTimeout: fallback.firstContentTimeout,
    health: fallback.health,
    healthNamespace: fallback.healthNamespace,
    healthStore: fallback.healthStore,
    maxAttempts: fallback.maxAttempts,
    retryAfterOutput: fallback.retryAfterOutput,
    retryBudget: fallback.retryBudget,
    selection: fallback.selection,
    shouldRetry: fallback.shouldRetry,
    strictStreamValidation: fallback.strictStreamValidation,
    totalTimeout: fallback.totalTimeout,
    validateResult: fallback.validateResult,
  };
  let asyncField = false;
  for (const value of Object.values(snapshot)) {
    if (consumeGenuinePromise(value)) {
      asyncField = true;
    }
  }
  if (asyncField) {
    throw new Error("ai-router: fallback options must be synchronous");
  }
  if (snapshot.healthStore !== undefined) {
    snapshot.healthStore = captureHealthStore(snapshot.healthStore);
  }
  if (isPlainObjectValue(snapshot.retryBudget)) {
    const budget = snapshot.retryBudget as RetryBudgetConfig;
    snapshot.retryBudget = {
      maxSamples: budget.maxSamples,
      minSamples: budget.minSamples,
      recoveryFailureRate: budget.recoveryFailureRate,
      tripFailureRate: budget.tripFailureRate,
      window: budget.window,
    };
  }
  if (isPlainObjectValue(snapshot.cooldown)) {
    const cooldown = snapshot.cooldown as { modelResetInterval?: number };
    snapshot.cooldown = {
      modelResetInterval: cooldown.modelResetInterval,
    };
  }
  for (const [name, value] of [
    ["classifyFailure", snapshot.classifyFailure],
    ["shouldRetry", snapshot.shouldRetry],
    ["validateResult", snapshot.validateResult],
  ] as const) {
    if (value !== undefined && typeof value !== "function") {
      throw new Error(`ai-router: fallback.${name} must be a function`);
    }
  }
  for (const [name, value] of [
    ["health", snapshot.health],
    ["retryAfterOutput", snapshot.retryAfterOutput],
    ["strictStreamValidation", snapshot.strictStreamValidation],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`ai-router: fallback.${name} must be a boolean`);
    }
  }
  return snapshot;
}

const MAX_SUPPORTED_URL_MEDIA_TYPES = 128;
const MAX_SUPPORTED_URL_PATTERNS = 128;
const MAX_SUPPORTED_URL_TOTAL_PATTERNS = 1024;
const MAX_SUPPORTED_URL_PATTERN_CHARS = 1_048_576;
const MAX_SUPPORTED_URL_PATTERN_LENGTH = 4096;
const SUPPORTED_URLS_DISCOVERY_TIMEOUT_MS = 1000;

function cloneSupportedUrlPattern(value: unknown): RegExp | undefined {
  try {
    const sourceGetter = Object.getOwnPropertyDescriptor(
      RegExp.prototype,
      "source"
    )?.get;
    if (sourceGetter === undefined) {
      return;
    }
    const source = Reflect.apply(sourceGetter, value, []);
    if (
      typeof source !== "string" ||
      source.length > MAX_SUPPORTED_URL_PATTERN_LENGTH
    ) {
      return;
    }
    let flags = "";
    for (const [property, flag] of [
      ["hasIndices", "d"],
      ["global", "g"],
      ["ignoreCase", "i"],
      ["multiline", "m"],
      ["dotAll", "s"],
      ["unicode", "u"],
      ["unicodeSets", "v"],
      ["sticky", "y"],
    ] as const) {
      const getter = Object.getOwnPropertyDescriptor(
        RegExp.prototype,
        property
      )?.get;
      if (getter !== undefined && Reflect.apply(getter, value, []) === true) {
        flags += flag;
      }
    }
    return new RegExp(source, flags);
  } catch {
    return;
  }
}

function cloneSupportedUrlPatterns(
  value: unknown
): { chars: number; patterns: RegExp[] } | undefined {
  if (!Array.isArray(value)) {
    return;
  }
  const length = Reflect.get(value, "length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_SUPPORTED_URL_PATTERNS
  ) {
    return;
  }
  consumeOwnDataPromiseFields(
    value,
    Array.from({ length }, (_, index) => index)
  );
  const patterns = new Array<RegExp>(length);
  let chars = 0;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return;
    }
    const pattern = cloneSupportedUrlPattern(Reflect.get(value, index));
    if (pattern === undefined) {
      return;
    }
    chars += pattern.source.length;
    patterns[index] = pattern;
  }
  return { chars, patterns };
}

function consumeSupportedUrlPromiseFields(
  value: object,
  keys: readonly string[]
): void {
  consumeOwnDataPromiseFields(value, keys);
  for (const key of keys) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        continue;
      }
      const patterns = descriptor.value;
      if (!Array.isArray(patterns)) {
        continue;
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(
        patterns,
        "length"
      );
      const length =
        lengthDescriptor !== undefined && "value" in lengthDescriptor
          ? lengthDescriptor.value
          : undefined;
      if (
        typeof length === "number" &&
        Number.isSafeInteger(length) &&
        length >= 0 &&
        length <= MAX_SUPPORTED_URL_PATTERNS
      ) {
        consumeOwnDataPromiseFields(
          patterns,
          Array.from({ length }, (_, index) => index)
        );
      }
    } catch {
      // Malformed Proxy containers cannot prevent later bounded cleanup.
    }
  }
}

function sanitizeSupportedUrls(value: unknown): Record<string, RegExp[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  try {
    const keys = boundedEnumerableOwnKeys(value, MAX_SUPPORTED_URL_MEDIA_TYPES);
    if (keys === undefined) {
      return {};
    }
    consumeSupportedUrlPromiseFields(value, keys);
    const result: Record<string, RegExp[]> = {};
    let totalPatterns = 0;
    let totalPatternChars = 0;
    for (const key of keys) {
      if (key === "then" || key.length === 0 || key.length > 256) {
        return {};
      }
      const cloned = cloneSupportedUrlPatterns(Reflect.get(value, key));
      if (cloned === undefined) {
        return {};
      }
      totalPatterns += cloned.patterns.length;
      totalPatternChars += cloned.chars;
      if (totalPatterns > MAX_SUPPORTED_URL_TOTAL_PATTERNS) {
        return {};
      }
      if (totalPatternChars > MAX_SUPPORTED_URL_PATTERN_CHARS) {
        return {};
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloned.patterns,
        writable: true,
      });
    }
    return result;
  } catch {
    return {};
  }
}

function settleSupportedUrls(
  supported: Promise<unknown>
): Promise<Record<string, RegExp[]>> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: Record<string, RegExp[]>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimerSafely(timeout);
      resolve(value);
    };
    try {
      timeout = scheduleTimer(
        () => finish({}),
        SUPPORTED_URLS_DISCOVERY_TIMEOUT_MS
      );
    } catch {
      finish({});
      return;
    }
    try {
      const chained = Promise.prototype.then.call(
        supported,
        (value: unknown) => finish(sanitizeSupportedUrls(value)),
        () => finish({})
      );
      try {
        Promise.prototype.then.call(
          chained,
          () => undefined,
          () => undefined
        );
      } catch {
        // A custom PromiseLike may return a non-Promise value.
      }
    } catch {
      finish({});
    }
  });
}

function assertSynchronousEntryFields(values: readonly unknown[]): void {
  let asyncField = false;
  for (const value of values) {
    if (consumeGenuinePromise(value)) {
      asyncField = true;
    }
  }
  if (asyncField) {
    throw new Error("ai-router: provider entry fields must be synchronous");
  }
}

/** Collapse any of the three `ProviderEntry` shapes into a {@link NormalizedEntry}. */
function normalizeEntry(entry: ProviderEntry): NormalizedEntry {
  if (typeof entry !== "object" || entry === null) {
    throw new Error("ai-router: each provider entry must be an object");
  }
  consumeOwnDataPromiseFields(entry, [
    "adaptiveConcurrency",
    "healthKey",
    "maxConcurrency",
    "model",
    "provider",
    "providerFamily",
    "supports",
  ]);
  // Wrapper entries are identified without evaluating either their `model`
  // getter or unrelated bare-model fields. This keeps extension getters out of
  // the alternate shape's validation path.
  if (!Reflect.has(entry, "model")) {
    const bareModel = snapshotLanguageModelV4(entry);
    if (bareModel !== undefined) {
      return { original: entry, raw: () => bareModel };
    }
    throw new Error("ai-router: each bare provider entry must be a v4 model");
  }
  // (2) Instance-object form: `{ model: <v4 model>, supports? }`.
  const candidate = entry as ProviderEntryFactory | ProviderEntryInstance;
  const candidateModel = Reflect.get(candidate, "model");
  if (consumeGenuinePromise(candidateModel)) {
    throw new Error("ai-router: provider entry model must be synchronous");
  }
  if (candidateModel !== null && typeof candidateModel === "object") {
    const instance = candidate as ProviderEntryInstance;
    const model = candidateModel as LanguageModelV4;
    const adaptiveConcurrency = instance.adaptiveConcurrency;
    const healthKey = instance.healthKey;
    const maxConcurrency = instance.maxConcurrency;
    const supports = instance.supports;
    const providerFamily = instance.providerFamily;
    assertSynchronousEntryFields([
      adaptiveConcurrency,
      healthKey,
      maxConcurrency,
      supports,
      providerFamily,
    ]);
    return {
      adaptiveConcurrency: snapshotAdaptiveConcurrency(adaptiveConcurrency),
      healthKey,
      maxConcurrency,
      supports: snapshotSupports(supports),
      original: entry,
      providerFamily,
      raw: () => model,
    };
  }
  // (3) Factory form: `{ provider, model: string, supports? }`.
  const factory = candidate as ProviderEntryFactory;
  const provider = factory.provider;
  const adaptiveConcurrency = factory.adaptiveConcurrency;
  const healthKey = factory.healthKey;
  const maxConcurrency = factory.maxConcurrency;
  const supports = factory.supports;
  const providerFamily = factory.providerFamily;
  assertSynchronousEntryFields([
    provider,
    adaptiveConcurrency,
    healthKey,
    maxConcurrency,
    supports,
    providerFamily,
  ]);
  if (typeof provider !== "function" || typeof candidateModel !== "string") {
    throw new Error(
      "ai-router: a factory entry requires a `provider` function and a string `model`"
    );
  }
  const model = candidateModel;
  return {
    adaptiveConcurrency: snapshotAdaptiveConcurrency(adaptiveConcurrency),
    healthKey,
    maxConcurrency,
    supports: snapshotSupports(supports),
    original: entry,
    providerFamily,
    label: model,
    raw: () => Reflect.apply(provider, factory, [model]),
  };
}

/**
 * A delegating `LanguageModelV4` for one logical id.
 *
 * For every request it:
 *  1. Detects the input modalities from the prompt.
 *  2. Keeps the candidate entries whose `supports` covers them, in order.
 *  3. Tries each candidate; on failure it classifies the error (retry vs stop),
 *     calls `onError`, and falls through to the next one when retryable.
 *  4. On `doStream`, wraps the live stream so a mid-stream failure also falls
 *     back transparently (before any content has been emitted).
 *  5. Surfaces the original error for a single failure, or an `AggregateError`
 *     of all candidate errors when several fail.
 *
 * It forwards an attempt-isolated copy of the V4 call options so one provider
 * cannot mutate the prompt or policy observed by later fallback candidates.
 */
class RouterLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "router";
  readonly modelId: string;

  private readonly normalized: NormalizedEntry[];
  private readonly onError?: OnRouterError;
  private readonly shouldRetry: ShouldRetryThisError;
  private readonly retryAfterOutput: boolean;
  private readonly cooldown?: CooldownState;
  private readonly health: CandidateHealthState;
  private readonly healthEnabled: boolean;
  private readonly classifyFailure: ClassifyFailure;
  private readonly hasCustomClassifier: boolean;
  private readonly hasCustomRetry: boolean;
  private readonly attemptTimeout?: number;
  private readonly concurrencyWaitTimeout?: number;
  private readonly backoff?: number;
  private readonly firstContentTimeout?: number;
  private readonly totalTimeout?: number;
  private readonly maxAttempts: number;
  private readonly onAttempt?: OnRouterAttempt;
  private readonly validateResult?: ValidateGenerateResult;
  private readonly strictStreamValidation: boolean;
  private readonly retryBudget?: RetryBudget;
  private readonly admission: AdmissionController;
  private readonly ordering: OrderingTokenSource;
  private readonly selection: "least-inflight" | "ordered" | "round-robin";

  /** Cache of instantiated models, keyed by candidate index. */
  private readonly modelCache = new Map<number, LanguageModelV4>();
  /** Permanent invalid-model results are cached; transient factory throws are not. */
  private readonly modelErrors = new Map<number, InvalidProviderModelError>();
  /** Memoized conservative `supportedUrls` (computed once per instance). */
  private supportedUrlsCache: Record<string, RegExp[]> = {};
  private supportedUrlsPromise?: Promise<Record<string, RegExp[]>>;
  private supportedUrlsComputed = false;

  constructor(
    logicalId: string,
    entries: ProviderEntry[],
    options: CreateRouterOptions,
    admissionRegistry: AdmissionRegistry,
    healthStore: RouterHealthStore,
    ordering: OrderingTokenSource
  ) {
    this.modelId = logicalId;
    this.ordering = ordering;
    const fallback = options.fallback;
    this.health = new CandidateHealthState(
      resolveHealthNamespace(logicalId, fallback?.healthNamespace),
      healthStore,
      Date.now,
      resolveSharedHealthNamespace(logicalId, fallback?.healthNamespace)
    );
    this.normalized = entries.map(normalizeEntry);
    for (const entry of this.normalized) {
      validateEntryConfiguration(entry);
      if (
        entry.maxConcurrency !== undefined &&
        (!Number.isSafeInteger(entry.maxConcurrency) ||
          entry.maxConcurrency < 1)
      ) {
        throw new Error("ai-router: maxConcurrency must be a positive integer");
      }
    }
    for (const [index, entry] of this.normalized.entries()) {
      this.health.register(index, entry.healthKey, entry.providerFamily);
    }
    validateSharedAdmission(this.normalized);
    this.onError = options.onError;
    this.onAttempt = options.onAttempt;
    this.shouldRetry = resolveShouldRetry(fallback?.shouldRetry);
    this.classifyFailure = fallback?.classifyFailure ?? defaultClassifyFailure;
    this.hasCustomClassifier = fallback?.classifyFailure !== undefined;
    this.hasCustomRetry = fallback?.shouldRetry !== undefined;
    this.retryAfterOutput = fallback?.retryAfterOutput ?? false;
    this.attemptTimeout = durationMs(fallback?.attemptTimeout);
    this.concurrencyWaitTimeout = durationMs(fallback?.concurrencyWaitTimeout);
    this.admission = new AdmissionController(
      this.normalized,
      this.concurrencyWaitTimeout,
      resolveHealthNamespace(logicalId, fallback?.healthNamespace),
      admissionRegistry
    );
    this.backoff =
      fallback?.backoff === false ? undefined : durationMs(fallback?.backoff);
    this.firstContentTimeout = durationMs(fallback?.firstContentTimeout);
    this.totalTimeout = durationMs(fallback?.totalTimeout);
    this.maxAttempts = Math.max(
      1,
      Math.floor(fallback?.maxAttempts ?? entries.length)
    );
    if (
      fallback?.maxAttempts !== undefined &&
      (!(
        Number.isFinite(fallback.maxAttempts) &&
        Number.isSafeInteger(fallback.maxAttempts)
      ) ||
        fallback.maxAttempts < 1)
    ) {
      throw new Error(
        "ai-router: maxAttempts must be a positive finite number"
      );
    }
    this.retryBudget = createRetryBudget(fallback?.retryBudget);
    const selection = fallback?.selection ?? "ordered";
    if (
      selection !== "ordered" &&
      selection !== "least-inflight" &&
      selection !== "round-robin"
    ) {
      throw new Error(
        'ai-router: selection must be "ordered", "least-inflight", or "round-robin"'
      );
    }
    this.selection = selection;
    this.validateResult = fallback?.validateResult;
    this.strictStreamValidation = fallback?.strictStreamValidation ?? false;
    const cfg = resolveCooldown(fallback?.cooldown);
    this.cooldown = cfg ? new CooldownState(cfg) : undefined;
    this.healthEnabled = fallback?.health ?? cfg !== undefined;
  }

  /**
   * The set of URLs the router can pass through un-downloaded. The AI SDK reads
   * this ONCE during call setup to decide whether to download+inline a URL or
   * forward it raw — but it cannot know which candidate will actually serve the
   * request. So we report only the support COMMON to every candidate: a URL is
   * passed through only if all candidates handle it natively; otherwise the SDK
   * inlines it (which any candidate accepts). Computed once and memoized.
   */
  get supportedUrls(): LanguageModelV4["supportedUrls"] {
    if (!this.supportedUrlsComputed) {
      const computed = this.computeSupportedUrls();
      if (computed instanceof Promise) {
        this.supportedUrlsPromise = computed;
      } else {
        this.supportedUrlsCache = computed;
      }
      this.supportedUrlsComputed = true;
    }
    if (this.supportedUrlsPromise !== undefined) {
      return this.supportedUrlsPromise.then(sanitizeSupportedUrls, () => ({}));
    }
    return sanitizeSupportedUrls(this.supportedUrlsCache);
  }

  private computeSupportedUrls():
    | Promise<Record<string, RegExp[]>>
    | Record<string, RegExp[]> {
    // With multiple candidates the router cannot know which one will serve the
    // request, so it conservatively reports NO native URL support — the SDK then
    // downloads + inlines every URL, which any candidate accepts. A lone
    // candidate can safely report its own support. Either way, a broken / non-v4
    // first entry must not abort call setup (read before any fallback runs).
    if (this.normalized.length !== 1) {
      return {};
    }
    try {
      const supported = this.instantiate(0).supportedUrls;
      if (
        supported !== null &&
        (typeof supported === "object" || typeof supported === "function")
      ) {
        const promise = captureGenuinePromise(supported);
        if (promise !== undefined) {
          return settleSupportedUrls(promise);
        }
        return sanitizeSupportedUrls(supported);
      }
      return sanitizeSupportedUrls(supported);
    } catch {
      return {};
    }
  }

  async doGenerate(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4GenerateResult> {
    const requestOptions = cloneInitialCallOptions(options);
    throwIfAborted(requestOptions.abortSignal);
    const selectedAt = this.nextOrderingToken();
    const { candidates, startIndex } = this.selectCandidates(
      requestOptions,
      "generate"
    );
    this.assertHasCandidate(candidates);

    const errors: unknown[] = [];
    const deadline =
      this.totalTimeout === undefined
        ? undefined
        : monotonicNow() + this.totalTimeout;
    let attempts = 0;
    let capacitySkips = 0;
    let healthSkips = 0;
    let budgetFailureObserved = false;
    let budgetSuppressed = false;
    let directRequestError: unknown;
    const requestMaxAttempts =
      this.retryBudget?.available() === false ? 1 : this.maxAttempts;
    for (let k = startIndex; k < candidates.length; k++) {
      if (attempts >= requestMaxAttempts) {
        this.emitSkipped(candidates.slice(k), "generate", "max-attempts");
        break;
      }
      const candidate = candidates[k];
      await this.backoffCandidate(
        candidate,
        attempts,
        requestOptions.abortSignal,
        deadline
      );
      if (this.becameUnavailable(candidate.fullIndex, selectedAt)) {
        healthSkips += 1;
        this.releaseCandidateProbe(candidate);
        this.emitSkipped([candidate], "generate", "cooldown");
        continue;
      }
      const admission = await this.admitCandidate(
        candidate,
        k === candidates.length - 1,
        requestOptions.abortSignal,
        deadline,
        selectedAt,
        "generate"
      );
      capacitySkips += Number(admission.capacitySkipped);
      healthSkips += Number(admission.healthSkipped);
      if (admission.inFlight === undefined) {
        continue;
      }
      const inFlight = admission.inFlight;
      const startedAt = monotonicNow();
      const attemptOrderingToken = this.nextOrderingToken();
      attempts += 1;
      try {
        const timing = this.attemptTiming(deadline);
        const result = await withTimeout(
          (signal) =>
            candidate.model.doGenerate(
              cloneCallOptions(requestOptions, signal)
            ),
          timing.timeoutMs,
          requestOptions.abortSignal,
          timing.code,
          this.timeoutDiagnosticDuration(timing.code),
          discardLateGenerateResult
        );
        const validatedResult = this.assertValidResult(result);
        const healthTransition = this.markSuccessIfEnabled(
          candidate.fullIndex,
          attemptOrderingToken
        );
        this.admission.observe(
          candidate.fullIndex,
          true,
          undefined,
          startedAt,
          attemptOrderingToken
        );
        this.retryBudget?.observe(true);
        this.commitSurvivor(candidate.fullIndex, errors.length > 0);
        this.emitAttempt({
          candidate,
          attempt: attempts,
          durationMs: Math.max(0, monotonicNow() - startedAt),
          outcome: "success",
          phase: "generate",
          index: candidate.fullIndex,
          inFlight,
          healthTransition,
        });
        return validatedResult;
      } catch (error) {
        const classification = this.classifyAttemptFailure(
          error,
          requestOptions.abortSignal
        );
        if (this.shouldSurfaceDirectly(classification)) {
          directRequestError = error;
        }
        this.admission.observe(
          candidate.fullIndex,
          false,
          classification,
          startedAt,
          attemptOrderingToken
        );
        budgetFailureObserved ||= this.isBudgetFailure(classification);
        budgetSuppressed ||= this.suppressesBudget(classification);
        const healthTransition = this.markFailureIfEnabled(
          candidate.fullIndex,
          classification,
          attemptOrderingToken
        );
        if (
          !this.handleFailure(
            error,
            candidate,
            k,
            candidates,
            errors,
            "generate",
            classification,
            attempts,
            requestMaxAttempts,
            deadline,
            startedAt,
            healthTransition,
            inFlight
          )
        ) {
          break;
        }
      } finally {
        this.releaseCandidateOwnership(candidate);
      }
    }
    this.observeRequestFailure(budgetFailureObserved, budgetSuppressed);
    if (directRequestError !== undefined) {
      throw directRequestError;
    }
    throw this.routeFailure(errors, capacitySkips, healthSkips);
  }

  async doStream(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4StreamResult> {
    const requestOptions = cloneInitialCallOptions(options);
    throwIfAborted(requestOptions.abortSignal);
    const selectedAt = this.nextOrderingToken();
    const { candidates, startIndex } = this.selectCandidates(
      requestOptions,
      "stream-open"
    );
    this.assertHasCandidate(candidates);

    const onAdvance = this.cooldown
      ? (filteredIndex: number, hadFailure: boolean) =>
          this.commitSurvivor(candidates[filteredIndex].fullIndex, hadFailure)
      : undefined;

    const errors: unknown[] = [];
    const deadline =
      this.totalTimeout === undefined
        ? undefined
        : monotonicNow() + this.totalTimeout;
    let attempts = 0;
    let capacitySkips = 0;
    let healthSkips = 0;
    let budgetFailureObserved = false;
    let budgetSuppressed = false;
    let directRequestError: unknown;
    const requestMaxAttempts =
      this.retryBudget?.available() === false ? 1 : this.maxAttempts;
    for (let k = startIndex; k < candidates.length; k++) {
      if (attempts >= requestMaxAttempts) {
        this.emitSkipped(candidates.slice(k), "stream-open", "max-attempts");
        break;
      }
      const candidate = candidates[k];
      await this.backoffCandidate(
        candidate,
        attempts,
        requestOptions.abortSignal,
        deadline
      );
      if (this.becameUnavailable(candidate.fullIndex, selectedAt)) {
        healthSkips += 1;
        this.releaseCandidateProbe(candidate);
        this.emitSkipped([candidate], "stream-open", "cooldown");
        continue;
      }
      const admission = await this.admitCandidate(
        candidate,
        k === candidates.length - 1,
        requestOptions.abortSignal,
        deadline,
        selectedAt,
        "stream-open"
      );
      capacitySkips += Number(admission.capacitySkipped);
      healthSkips += Number(admission.healthSkipped);
      if (admission.inFlight === undefined) {
        continue;
      }
      const inFlight = admission.inFlight;
      const startedAt = monotonicNow();
      const attemptOrderingToken = this.nextOrderingToken();
      attempts += 1;
      let result: LanguageModelV4StreamResult;
      try {
        // Errors thrown BEFORE the stream opens are caught here; errors that
        // arrive AFTER it opens are handled inside wrapStreamResult.
        const timing = this.attemptTiming(deadline);
        result = await withTimeout(
          (signal) =>
            candidate.model.doStream(cloneCallOptions(requestOptions, signal)),
          timing.timeoutMs,
          requestOptions.abortSignal,
          timing.code,
          this.timeoutDiagnosticDuration(timing.code),
          discardLateStreamResult
        );
      } catch (error) {
        const classification = this.classifyAttemptFailure(
          error,
          requestOptions.abortSignal
        );
        if (this.shouldSurfaceDirectly(classification)) {
          directRequestError = error;
        }
        this.admission.observe(
          candidate.fullIndex,
          false,
          classification,
          startedAt,
          attemptOrderingToken
        );
        budgetFailureObserved ||= this.isBudgetFailure(classification);
        budgetSuppressed ||= this.suppressesBudget(classification);
        const healthTransition = this.markFailureIfEnabled(
          candidate.fullIndex,
          classification,
          attemptOrderingToken
        );
        this.releaseCandidateProbe(candidate);
        let shouldContinue: boolean;
        try {
          shouldContinue = this.handleFailure(
            error,
            candidate,
            k,
            candidates,
            errors,
            "stream-open",
            classification,
            attempts,
            requestMaxAttempts,
            deadline,
            startedAt,
            healthTransition,
            inFlight
          );
        } finally {
          this.admission.release(candidate.fullIndex);
        }
        if (!shouldContinue) {
          break;
        }
        continue;
      }
      return wrapStreamResult({
        logicalId: this.modelId,
        candidates,
        startIndex: k,
        options: requestOptions,
        prepareCandidate: (entry) => this.prepareCandidate(entry),
        firstResult: result,
        shouldRetry: () => true,
        strictStreamValidation: this.strictStreamValidation,
        classifyFailure: (error) => this.classify(error),
        concurrencyLimit: (entry) => this.admission.limit(entry.fullIndex),
        candidateInFlight: (entry) => this.admission.inFlight(entry.fullIndex),
        attemptTimeout: this.attemptTimeout,
        backoff: this.backoff,
        retryAfterOutput: this.retryAfterOutput,
        firstContentTimeout: this.firstContentTimeout,
        maxAttempts: requestMaxAttempts,
        totalDeadline: deadline,
        totalTimeout: this.totalTimeout,
        attemptsStarted: attempts,
        startAttemptStartedAt: startedAt,
        startInFlight: inFlight,
        startOrderingToken: attemptOrderingToken,
        nextOrderingToken: () => this.nextOrderingToken(),
        candidateAvailable: (entry) =>
          !this.becameUnavailable(entry.fullIndex, selectedAt),
        acquireCandidate: (entry) => this.admission.acquire(entry.fullIndex),
        waitForCandidate: (entry, signal) =>
          this.admission.waitFor(
            entry.fullIndex,
            signal ?? requestOptions.abortSignal,
            deadline
          ),
        releaseCandidate: (entry) => this.admission.release(entry.fullIndex),
        releaseProbeCandidate: (entry) => this.releaseCandidateProbe(entry),
        budgetFailureObserved,
        budgetSuppressed,
        isBudgetFailure: (failure) => this.isBudgetFailure(failure),
        onRequestOutcome: (success, eligibleFailure, suppressed) => {
          if (success) {
            this.retryBudget?.observe(true);
          } else {
            this.observeRequestFailure(eligibleFailure, suppressed);
          }
        },
        onError: this.onError,
        onAttempt: this.onAttempt,
        onCandidateFailure: (
          entry,
          failure,
          attemptStartedAt,
          attemptStartedMonotonic
        ) => {
          this.admission.observe(
            entry.fullIndex,
            false,
            failure,
            attemptStartedMonotonic,
            attemptStartedAt
          );
          return this.markFailureIfEnabled(
            entry.fullIndex,
            failure,
            attemptStartedAt
          );
        },
        onCandidateSuccess: (
          entry,
          attemptStartedAt,
          attemptStartedMonotonic
        ) => {
          this.admission.observe(
            entry.fullIndex,
            true,
            undefined,
            attemptStartedMonotonic,
            attemptStartedAt
          );
          return this.markSuccessIfEnabled(entry.fullIndex, attemptStartedAt);
        },
        onAdvance,
        priorErrors: errors,
      });
    }
    this.observeRequestFailure(budgetFailureObserved, budgetSuppressed);
    if (directRequestError !== undefined) {
      throw directRequestError;
    }
    throw this.routeFailure(errors, capacitySkips, healthSkips);
  }

  /**
   * Record the error, classify it, notify `onError`, and report whether the
   * router should keep trying the next candidate (`true`) or stop (`false`).
   */
  private handleFailure(
    error: unknown,
    candidate: ResolvedEntry,
    filteredIndex: number,
    candidates: ResolvedEntry[],
    errors: unknown[],
    phase: "generate" | "stream-open",
    classification: FailureClassification,
    attempt: number,
    attemptLimit: number,
    deadline: number | undefined,
    startedAt: number,
    healthTransition?: HealthTransition,
    inFlight?: number
  ): boolean {
    recordFailure(errors, error);
    const retry = classification.retryable;
    const hasNext =
      retry &&
      attempt < attemptLimit &&
      this.hasRetryCandidate(
        candidates,
        filteredIndex + 1,
        deadline,
        candidate.fullIndex
      );
    const errorPayload = {
      logicalId: this.modelId,
      entry: candidate.entry,
      index: candidate.fullIndex,
      error,
      phase,
      willRetry: hasNext,
    };
    runErrorObservabilityHook(errorPayload, (event) => this.onError?.(event));
    this.emitAttempt({
      candidate,
      attempt,
      durationMs: Math.max(0, monotonicNow() - startedAt),
      error,
      failure: classification,
      healthTransition,
      inFlight,
      outcome: "failure",
      phase,
      index: candidate.fullIndex,
      willRetry: hasNext,
    });
    return retry;
  }

  private routeFailure(
    errors: unknown[],
    capacitySkips: number,
    healthSkips: number
  ): unknown {
    if (errors.length === 0 && capacitySkips > 0) {
      return new RouterConcurrencyError(this.modelId);
    }
    if (errors.length === 0 && healthSkips > 0) {
      return new RouterHealthUnavailableError(this.modelId);
    }
    return surfaceFailure(errors, this.modelId);
  }

  private hasRetryCandidate(
    candidates: ResolvedEntry[],
    startIndex: number,
    deadline: number | undefined,
    releasingIndex?: number
  ): boolean {
    for (let index = startIndex; index < candidates.length; index++) {
      const candidate = candidates[index];
      const entry = this.normalized[candidate.fullIndex];
      if (
        this.healthEnabled &&
        !this.health.available(
          candidate.fullIndex,
          entry.healthKey,
          entry.providerFamily
        )
      ) {
        continue;
      }
      if (
        releasingIndex === undefined
          ? this.admission.canAcquire(candidate.fullIndex)
          : this.admission.canAcquireAfterRelease(
              candidate.fullIndex,
              releasingIndex
            )
      ) {
        return true;
      }
      if (
        index === candidates.length - 1 &&
        this.concurrencyWaitTimeout !== undefined &&
        (deadline === undefined || monotonicNow() < deadline)
      ) {
        return true;
      }
    }
    return false;
  }

  private classify(error: unknown): FailureClassification {
    if (isTerminalRequestFailure(error)) {
      return { retryable: false, scope: "request" };
    }
    try {
      const classification = normalizeFailureClassification(
        this.classifyFailure(error)
      );
      if (this.hasCustomClassifier || !this.hasCustomRetry) {
        return classification;
      }
      return {
        ...classification,
        retryable: safeShouldRetry(this.shouldRetry, error),
      };
    } catch {
      return { retryable: false, scope: "request" };
    }
  }

  private classifyAttemptFailure(
    error: unknown,
    callerSignal: AbortSignal | undefined
  ): FailureClassification {
    // Abort reasons are allowed to be arbitrary JavaScript values. When the
    // provider ignores the signal, withTimeout races it and preserves that
    // exact reason; classifying the reason alone would mistake an Error or
    // string for a transient provider outage.
    if (isSignalAborted(callerSignal)) {
      return { retryable: false, scope: "request" };
    }
    return this.classify(error);
  }

  private shouldSurfaceDirectly(
    classification: FailureClassification
  ): boolean {
    return (
      !classification.retryable &&
      classification.scope === "request" &&
      classification.statusCode === undefined
    );
  }

  private attemptTiming(deadline: number | undefined): {
    code: "attempt_timeout" | "total_timeout";
    timeoutMs: number | undefined;
  } {
    const remaining =
      deadline === undefined ? undefined : deadline - monotonicNow();
    if (remaining !== undefined && remaining <= 0) {
      throw new RouterTimeoutError("total_timeout", this.totalTimeout ?? 0);
    }
    const timeoutMs = effectiveTimeout(this.attemptTimeout, remaining);
    return {
      code:
        remaining !== undefined && timeoutMs === remaining
          ? "total_timeout"
          : "attempt_timeout",
      timeoutMs,
    };
  }

  private timeoutDiagnosticDuration(
    code: "attempt_timeout" | "total_timeout"
  ): number | undefined {
    return code === "total_timeout" ? this.totalTimeout : this.attemptTimeout;
  }

  private backoffAfterAttempt(
    attempts: number,
    signal: AbortSignal | undefined,
    deadline: number | undefined
  ): Promise<void> {
    if (attempts === 0) {
      return Promise.resolve();
    }
    const remaining =
      deadline === undefined ? undefined : deadline - monotonicNow();
    if (remaining !== undefined && remaining <= 0) {
      return Promise.reject(
        new RouterTimeoutError("total_timeout", this.totalTimeout ?? 0)
      );
    }
    const maximum =
      remaining === undefined || this.backoff === undefined
        ? this.backoff
        : Math.min(this.backoff, remaining);
    return jitteredBackoff(maximum, signal);
  }

  private async backoffCandidate(
    candidate: ResolvedEntry,
    attempts: number,
    signal: AbortSignal | undefined,
    deadline: number | undefined
  ): Promise<void> {
    try {
      await this.backoffAfterAttempt(attempts, signal, deadline);
    } catch (error) {
      this.releaseCandidateProbe(candidate);
      throw error;
    }
  }

  private releaseCandidateProbe(candidate: ResolvedEntry): void {
    const lease = candidate.probeLease;
    candidate.probeLease = undefined;
    this.health.releaseProbe(lease);
  }

  private releaseCandidateOwnership(candidate: ResolvedEntry): void {
    try {
      this.admission.release(candidate.fullIndex);
    } finally {
      this.releaseCandidateProbe(candidate);
    }
  }

  private prepareCandidate(candidate: ResolvedEntry): boolean {
    if (!this.healthEnabled) {
      return true;
    }
    const entry = this.normalized[candidate.fullIndex];
    if (
      !this.health.claimProbe(
        candidate.fullIndex,
        entry.healthKey,
        entry.providerFamily
      )
    ) {
      return false;
    }
    candidate.probeLease = this.health.takeProbeLease(
      candidate.fullIndex,
      entry.healthKey,
      entry.providerFamily
    );
    return true;
  }

  private acceptAdmission(
    candidate: ResolvedEntry,
    inFlight: number | undefined,
    selectedAt: RouterOrderingToken,
    phase: "generate" | "stream-open"
  ): inFlight is number {
    if (inFlight === undefined) {
      this.releaseCandidateProbe(candidate);
      this.emitSkipped([candidate], phase, "concurrency");
      return false;
    }
    if (this.becameUnavailable(candidate.fullIndex, selectedAt)) {
      this.releaseCandidateOwnership(candidate);
      this.emitSkipped([candidate], phase, "cooldown");
      return false;
    }
    return true;
  }

  private async admitCandidate(
    candidate: ResolvedEntry,
    isLast: boolean,
    signal: AbortSignal | undefined,
    deadline: number | undefined,
    selectedAt: RouterOrderingToken,
    phase: "generate" | "stream-open"
  ): Promise<{
    capacitySkipped: boolean;
    healthSkipped: boolean;
    inFlight?: number;
  }> {
    let ownsCapacity = false;
    try {
      if (!this.prepareCandidate(candidate)) {
        this.emitSkipped([candidate], phase, "cooldown");
        return { capacitySkipped: false, healthSkipped: true };
      }
      let inFlight = this.admission.acquire(candidate.fullIndex);
      ownsCapacity = inFlight !== undefined;
      if (
        inFlight === undefined &&
        isLast &&
        this.concurrencyWaitTimeout !== undefined
      ) {
        // A queued request is not probing the provider yet. Do not reserve the
        // half-open lease while waiting (possibly longer than the lease itself);
        // reclaim it only after admission grants a real slot.
        this.releaseCandidateProbe(candidate);
        inFlight = await this.admission.waitFor(
          candidate.fullIndex,
          signal,
          deadline
        );
        ownsCapacity = inFlight !== undefined;
        if (
          inFlight === undefined &&
          deadline !== undefined &&
          monotonicNow() >= deadline
        ) {
          throw new RouterTimeoutError("total_timeout", this.totalTimeout ?? 0);
        }
        if (inFlight !== undefined && !this.prepareCandidate(candidate)) {
          this.releaseCandidateOwnership(candidate);
          ownsCapacity = false;
          this.emitSkipped([candidate], phase, "cooldown");
          return { capacitySkipped: false, healthSkipped: true };
        }
      }
      const capacitySkipped = inFlight === undefined;
      const accepted = this.acceptAdmission(
        candidate,
        inFlight,
        selectedAt,
        phase
      );
      ownsCapacity = false;
      return accepted
        ? { capacitySkipped, healthSkipped: false, inFlight }
        : { capacitySkipped, healthSkipped: !capacitySkipped };
    } catch (error) {
      if (ownsCapacity) {
        this.releaseCandidateOwnership(candidate);
      } else {
        this.releaseCandidateProbe(candidate);
      }
      throw error;
    }
  }

  private assertValidResult(
    result: LanguageModelV4GenerateResult
  ): LanguageModelV4GenerateResult {
    let snapshot: LanguageModelV4GenerateResult;
    try {
      snapshot = snapshotGenerateEnvelope(result);
    } catch {
      throw new InvalidModelResponseError(
        "result properties could not be read"
      );
    }
    const shapeError = validateGenerateEnvelope(snapshot);
    if (shapeError !== undefined) {
      throw new InvalidModelResponseError(shapeError);
    }
    snapshot = {
      ...snapshot,
      content: [...snapshot.content],
      warnings: [...snapshot.warnings],
    };
    if (!hasOutputContent(snapshot)) {
      throw new EmptyModelResponseError();
    }
    if (this.validateResult === undefined) {
      return snapshot;
    }
    const validatorInput = snapshotGenerateEnvelope(snapshot);
    const validatorMutationTargets =
      captureValidatorMutationTargets(validatorInput);
    let validation: unknown;
    try {
      validation = this.validateResult(validatorInput);
    } catch (error) {
      throw new ValidatorContractError("threw", error);
    } finally {
      consumeOwnDataPromiseFields(validatorInput, GENERATE_ENVELOPE_FIELDS);
      consumeNestedValidatorInputPromiseMutations(validatorInput);
      consumeCapturedValidatorMutationPromises(validatorMutationTargets);
    }
    if (
      ((typeof validation === "object" && validation !== null) ||
        typeof validation === "function") &&
      consumeGenuinePromise(validation)
    ) {
      throw new ValidatorContractError("must be synchronous");
    }
    if (validation === true) {
      return snapshot;
    }
    if (validation === false) {
      throw new InvalidModelResponseError("custom validator returned false");
    }
    if (typeof validation === "string") {
      throw new InvalidModelResponseError(validation);
    }
    throw new ValidatorContractError("must return boolean or string");
  }

  private emitAttempt(
    info: Omit<Parameters<OnRouterAttempt>[0], "entry" | "logicalId"> & {
      candidate: ResolvedEntry;
    }
  ): void {
    const { candidate, failure, ...rest } = info;
    const payload = {
      ...rest,
      ...(failure === undefined ? {} : { failure: { ...failure } }),
      ...(rest.concurrencyLimit === undefined
        ? { concurrencyLimit: this.admission.limit(candidate.fullIndex) }
        : {}),
      entry: candidate.entry,
      logicalId: this.modelId,
    };
    runAttemptObservabilityHook(payload, (event) => this.onAttempt?.(event));
  }

  private emitSkipped(
    candidates: ResolvedEntry[],
    phase: "generate" | "stream-open",
    reason: "concurrency" | "cooldown" | "max-attempts"
  ): void {
    for (const candidate of candidates) {
      this.emitAttempt({
        candidate,
        durationMs: 0,
        index: candidate.fullIndex,
        outcome: "skipped",
        phase,
        reason,
        concurrencyLimit: this.admission.limit(candidate.fullIndex),
        ...(reason === "concurrency"
          ? {
              inFlight: this.admission.inFlight(candidate.fullIndex),
            }
          : {}),
      });
    }
  }

  private markFailure(
    index: number,
    classification: FailureClassification,
    attemptStartedAt: RouterOrderingToken = Date.now()
  ): HealthTransition {
    const entry = this.normalized[index];
    return this.health.failure(
      index,
      classification,
      entry.healthKey,
      entry.providerFamily,
      attemptStartedAt
    );
  }

  private markFailureIfEnabled(
    index: number,
    classification: FailureClassification,
    attemptStartedAt: RouterOrderingToken = Date.now()
  ): HealthTransition | undefined {
    if (this.healthEnabled && classification.scope !== "request") {
      return this.markFailure(index, classification, attemptStartedAt);
    }
    return;
  }

  private markSuccess(
    index: number,
    attemptStartedAt: RouterOrderingToken = Date.now()
  ): HealthTransition | undefined {
    const entry = this.normalized[index];
    return this.health.success(
      index,
      entry.healthKey,
      entry.providerFamily,
      attemptStartedAt
    );
  }

  private markSuccessIfEnabled(
    index: number,
    attemptStartedAt: RouterOrderingToken = Date.now()
  ): HealthTransition | undefined {
    if (this.healthEnabled) {
      return this.markSuccess(index, attemptStartedAt);
    }
    return;
  }

  private becameUnavailable(
    index: number,
    selectedAt: RouterOrderingToken
  ): boolean {
    if (!this.healthEnabled) {
      return false;
    }
    const entry = this.normalized[index];
    return this.health.unavailableSince(
      index,
      selectedAt,
      entry.healthKey,
      entry.providerFamily
    );
  }

  private nextOrderingToken(): RouterOrderingToken {
    return this.ordering.next();
  }

  private isBudgetFailure(failure: FailureClassification): boolean {
    return failure.retryable && failure.scope !== "request";
  }

  private suppressesBudget(failure: FailureClassification): boolean {
    return !failure.retryable && failure.scope === "request";
  }

  private observeRequestFailure(eligible: boolean, suppressed: boolean): void {
    if (eligible && !suppressed) {
      this.retryBudget?.observe(false);
    }
  }

  healthSnapshot(): RouterHealthSnapshot[] {
    return this.health.snapshot();
  }

  admissionSnapshot(): RouterAdmissionSnapshot[] {
    return this.normalized.map((_, index) => ({
      ...this.admission.snapshot(index),
      logicalId: this.modelId,
    }));
  }

  retryBudgetSnapshot(): RouterRetryBudgetSnapshot | undefined {
    const snapshot = this.retryBudget?.snapshot();
    return snapshot === undefined
      ? undefined
      : { ...snapshot, logicalId: this.modelId };
  }

  /**
   * Commit a survivor into cooldown state, but only when reaching it actually
   * involved an earlier candidate failing (`hadFailure`), or when it is the
   * primary recovering (`fullIndex === 0`). A candidate reached merely because
   * earlier entries were modality-filtered out must NOT become sticky —
   * otherwise a later request of a different modality would skip a perfectly
   * healthy higher-priority primary. No-op when cooldown is disabled.
   */
  private commitSurvivor(fullIndex: number, hadFailure: boolean): void {
    if (hadFailure || fullIndex === 0) {
      this.cooldown?.advanceTo(fullIndex);
    }
  }

  private assertHasCandidate(candidates: ResolvedEntry[]): void {
    if (candidates.length === 0) {
      throw new Error(
        `ai-router: no candidate for "${this.modelId}" supports the requested input modalities`
      );
    }
  }

  /** Lazily instantiate (and cache) the model for a candidate index. */
  private instantiate(index: number): LanguageModelV4 {
    // Cached models are always defined objects, so a present entry short-circuits
    // without a second Map lookup (and never re-creates a candidate).
    const cached = this.modelCache.get(index);
    if (cached !== undefined) {
      return cached;
    }
    const cachedError = this.modelErrors.get(index);
    if (cachedError !== undefined) {
      throw cachedError;
    }

    const entry = this.normalized[index];
    const model = entry.raw();
    // Fail fast — outside the fallback loop — if a factory or instance entry did
    // not yield a v4 language model (a bare model-id string, or an older spec).
    // Otherwise it would crash deep inside the routed call and be swallowed into
    // fallback as an opaque error.
    const stableModel = snapshotLanguageModelV4(model);
    if (stableModel === undefined) {
      const error = new InvalidProviderModelError(
        entry.label === undefined
          ? `ai-router: entry for "${this.modelId}" did not provide a v4 LanguageModel`
          : `ai-router: provider for "${this.modelId}" (model "${entry.label}") did not return a v4 LanguageModel`
      );
      this.modelErrors.set(index, error);
      throw error;
    }
    this.modelCache.set(index, stableModel);
    return stableModel;
  }

  /**
   * Filter entries by the prompt's required modalities and order them for this
   * request. With sticky cooldown, the active survivor is promoted to the head
   * instead of becoming a start offset, so every other compatible candidate
   * remains reachable if that survivor fails.
   */
  private selectCandidates(
    options: LanguageModelV4CallOptions,
    phase: "generate" | "stream-open"
  ): {
    candidates: ResolvedEntry[];
    startIndex: number;
  } {
    const required = detectModalities(options.prompt);
    const candidates: ResolvedEntry[] = [];
    const coolingCandidates: ResolvedEntry[] = [];
    const router = this;
    for (let i = 0; i < this.normalized.length; i++) {
      if (supportsAll(this.normalized[i].supports, required)) {
        const index = i;
        const resolved: ResolvedEntry = {
          entry: this.normalized[i].original,
          // Instantiate lazily, on first access, so a later candidate whose
          // factory throws (or yields a non-v4 model) is treated as a normal
          // candidate failure (classified + fallen through) rather than aborting
          // the whole request before a healthy higher-priority candidate runs.
          get model() {
            return router.instantiate(index);
          },
          fullIndex: i,
        };
        if (
          this.healthEnabled &&
          !this.health.available(
            i,
            this.normalized[i].healthKey,
            this.normalized[i].providerFamily
          )
        ) {
          coolingCandidates.push(resolved);
        } else {
          candidates.push(resolved);
        }
      }
    }

    this.emitSkipped(coolingCandidates, phase, "cooldown");
    if (candidates.length === 0 && coolingCandidates.length > 0) {
      throw new RouterHealthUnavailableError(this.modelId);
    }

    if (this.cooldown) {
      this.cooldown.checkAndReset();
      const active = this.cooldown.current();
      // Honor the sticky survivor ONLY when it is itself present in this request's
      // modality-filtered set. If it was filtered out, re-probe from the top
      // rather than skipping forward to a later candidate (which would silently
      // bypass a healthy higher-priority candidate for this modality).
      const pos = candidates.findIndex(
        (candidate) => candidate.fullIndex === active
      );
      if (pos > 0) {
        const [sticky] = candidates.splice(pos, 1);
        if (sticky !== undefined) {
          candidates.unshift(sticky);
        }
      }
      // Keep the sticky survivor (or the first modality-compatible candidate
      // when it is absent) first. Selection policies only balance the fallback
      // tail and therefore cannot bypass the cooldown decision.
      this.applySelection(candidates, 1);
    } else {
      this.applySelection(candidates);
    }
    return { candidates, startIndex: 0 };
  }

  private applySelection(candidates: ResolvedEntry[], from = 0): void {
    if (from === 0) {
      this.admission.reorder(candidates, this.selection);
      return;
    }
    const tail = candidates.slice(from);
    this.admission.reorder(tail, this.selection);
    candidates.splice(from, tail.length, ...tail);
  }
}

function snapshotRouteEntries(
  logicalId: string,
  entries: unknown
): ProviderEntry[] {
  if (consumeGenuinePromise(entries)) {
    throw new Error(`ai-router: model id "${logicalId}" must be synchronous`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(
      `ai-router: model id "${logicalId}" must map to a provider entry array`
    );
  }
  let entryCount: number;
  try {
    entryCount = Reflect.get(entries, "length");
  } catch {
    throw new Error(
      `ai-router: model id "${logicalId}" candidate array is unreadable`
    );
  }
  if (!Number.isSafeInteger(entryCount) || entryCount < 0) {
    throw new Error(
      `ai-router: model id "${logicalId}" candidate array is unreadable`
    );
  }
  if (entryCount === 0) {
    throw new Error(
      `ai-router: model id "${logicalId}" has no provider entries`
    );
  }
  if (entryCount > MAX_ROUTE_CANDIDATES) {
    throw new Error(
      `ai-router: model id "${logicalId}" exceeds ${MAX_ROUTE_CANDIDATES} candidates`
    );
  }
  consumeOwnDataPromiseFields(
    entries,
    Array.from({ length: entryCount }, (_, index) => index)
  );
  const snapshot: ProviderEntry[] = [];
  let asyncEntry = false;
  for (let index = 0; index < entryCount; index += 1) {
    if (!Object.hasOwn(entries, index)) {
      throw new Error(
        `ai-router: model id "${logicalId}" candidate array must not contain holes`
      );
    }
    try {
      const entry = Reflect.get(entries, index);
      if (consumeGenuinePromise(entry)) {
        asyncEntry = true;
      } else {
        snapshot.push(entry as ProviderEntry);
      }
    } catch {
      throw new Error(
        `ai-router: model id "${logicalId}" candidate entry ${index} is unreadable`
      );
    }
  }
  if (asyncEntry) {
    throw new Error(
      `ai-router: model id "${logicalId}" candidates must be synchronous`
    );
  }
  return snapshot;
}

/** Validate route cardinality before allocating long-lived model state. */
function configuredRoutes(
  models: CreateRouterOptions["models"]
): [string, CreateRouterOptions["models"][string]][] {
  const logicalIds = boundedEnumerableOwnKeys(models, MAX_LOGICAL_ROUTES);
  if (logicalIds === undefined) {
    throw new Error(
      `ai-router: models must contain at most ${MAX_LOGICAL_ROUTES} logical routes`
    );
  }
  consumeOwnDataPromiseFields(models, logicalIds);
  const routes: [string, CreateRouterOptions["models"][string]][] = [];
  let totalCandidates = 0;
  for (const logicalId of logicalIds) {
    if (
      logicalId.trim().length === 0 ||
      logicalId.length > MAX_LOGICAL_ID_LENGTH
    ) {
      throw new Error(
        `ai-router: model ids must be non-empty and at most ${MAX_LOGICAL_ID_LENGTH} characters`
      );
    }
    const entrySnapshot = snapshotRouteEntries(
      logicalId,
      Reflect.get(models, logicalId)
    );
    totalCandidates += entrySnapshot.length;
    if (totalCandidates > MAX_TOTAL_ROUTE_CANDIDATES) {
      throw new Error(
        `ai-router: models exceed ${MAX_TOTAL_ROUTE_CANDIDATES} total candidates`
      );
    }
    routes.push([logicalId, entrySnapshot]);
  }
  return routes;
}

/** Create a modality-aware router with provider fallback. */
export function createRouter(options: CreateRouterOptions): Router {
  if (consumeGenuinePromise(options)) {
    throw new Error("ai-router: createRouter options must be synchronous");
  }
  if (typeof options !== "object" || options === null) {
    throw new Error("ai-router: createRouter options must be an object");
  }
  const keys = ["fallback", "models", "onAttempt", "onError"] as const;
  consumeOwnDataPromiseFields(options, keys);
  const models = options.models;
  const fallback = options.fallback;
  const onAttempt = options.onAttempt;
  const onError = options.onError;
  let asyncOption = false;
  for (const value of [models, fallback, onAttempt, onError]) {
    if (consumeGenuinePromise(value)) {
      asyncOption = true;
    }
  }
  if (asyncOption) {
    throw new Error("ai-router: createRouter options must be synchronous");
  }
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    throw new Error("ai-router: models must be an object of candidate arrays");
  }
  const cache = new Map<string, RouterLanguageModel>();
  const admissionRegistry = new AdmissionRegistry();
  if (onAttempt !== undefined && typeof onAttempt !== "function") {
    throw new Error("ai-router: onAttempt must be a function");
  }
  if (onError !== undefined && typeof onError !== "function") {
    throw new Error("ai-router: onError must be a function");
  }
  const optionSnapshot: CreateRouterOptions = {
    fallback: snapshotFallback(fallback),
    models,
    onAttempt,
    onError,
  };
  const healthStore =
    optionSnapshot.fallback?.healthStore ?? new MemoryRouterHealthStore();
  const ordering = orderingTokenSourceFor(healthStore);

  // Validate every logical route up front without constructing model wrappers
  // or instantiating provider factories. This avoids partial registry growth
  // when a later route pushes the aggregate configuration over its limit.
  // Construction is now bounded and cannot fail due to route cardinality.
  for (const [logicalId, entries] of configuredRoutes(models)) {
    cache.set(
      logicalId,
      new RouterLanguageModel(
        logicalId,
        entries,
        optionSnapshot,
        admissionRegistry,
        healthStore,
        ordering
      )
    );
  }

  const route = (logicalId: string): LanguageModel => {
    const cached = cache.get(logicalId);
    if (cached !== undefined) {
      return cached;
    }
    throw new Error(`ai-router: unknown model id "${logicalId}"`);
  };
  return Object.assign(route, {
    getAdmissionSnapshot(logicalId?: string): RouterAdmissionSnapshot[] {
      if (logicalId !== undefined) {
        if (!cache.has(logicalId)) {
          return [];
        }
        return cache.get(logicalId)?.admissionSnapshot() ?? [];
      }
      return [...cache.values()].flatMap((model) => model.admissionSnapshot());
    },
    getHealthSnapshot(logicalId?: string): RouterHealthSnapshot[] {
      if (logicalId !== undefined) {
        if (!cache.has(logicalId)) {
          return [];
        }
        return cache.get(logicalId)?.healthSnapshot() ?? [];
      }
      const snapshots = [...cache.values()].flatMap((model) =>
        model.healthSnapshot()
      );
      return [
        ...new Map(
          snapshots.map((snapshot) => [snapshot.key, snapshot] as const)
        ).values(),
      ];
    },
    getRetryBudgetSnapshot(logicalId?: string): RouterRetryBudgetSnapshot[] {
      if (logicalId !== undefined) {
        if (!cache.has(logicalId)) {
          return [];
        }
        const snapshot = cache.get(logicalId)?.retryBudgetSnapshot();
        return snapshot === undefined ? [] : [snapshot];
      }
      return [...cache.values()]
        .map((model) => model.retryBudgetSnapshot())
        .filter(
          (snapshot): snapshot is RouterRetryBudgetSnapshot =>
            snapshot !== undefined
        );
    },
  });
}
