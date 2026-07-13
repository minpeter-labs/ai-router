import {
  boundedEnumerableOwnKeys,
  hasInvalidHttpHeaderValueCharacter,
  isValidHttpHeaderName,
} from "./http-headers";
import {
  isBoundedIdentifier,
  isDateValue,
  isDenseArray,
  isDottedIdentifier,
  isUint8ArrayValue,
  isUrlValue,
} from "./runtime-types";

export class EmptyModelResponseError extends Error {
  readonly code = "empty_model_response";

  constructor() {
    super("ai-router: provider returned an empty model response");
    this.name = "EmptyModelResponseError";
  }
}

export class InvalidModelResponseError extends Error {
  readonly code = "invalid_model_response";

  constructor(message: string) {
    super(`ai-router: provider response rejected: ${message}`);
    this.name = "InvalidModelResponseError";
  }
}

export class ValidatorContractError extends Error {
  readonly code = "validator_contract_error";

  constructor(message: string, cause?: unknown) {
    super(`ai-router: validateResult ${message}`, { cause });
    this.name = "ValidatorContractError";
  }
}

export const CONTENT_TYPES = new Set([
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
export const FINISH_REASONS = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
]);
export const MAX_GENERATE_CONTENT_PARTS = 10_000;
export const MAX_GENERATE_JSON_CONTAINERS = 50_000;
export const MAX_GENERATE_JSON_CHARACTERS = 4_194_304;
export const MAX_GENERATE_METADATA_CHARACTERS = 4_194_304;
export const MAX_METADATA_FIELD_LENGTH = 65_536;
export const MAX_RESULT_WARNINGS = 1024;
export const MAX_RESULT_WARNING_CHARS = 1_048_576;
export const MAX_RESULT_WARNING_FIELD_LENGTH = 65_536;
export const MAX_RESULT_HEADERS = 1024;
export const MAX_RESULT_HEADER_LENGTH = 65_536;
export const MAX_RESULT_HEADER_CHARS = 1_048_576;
export function validUsageNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

export function validOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

export function validOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function validWarningString(value: unknown): boolean {
  return (
    typeof value === "string" && value.length <= MAX_RESULT_WARNING_FIELD_LENGTH
  );
}

export function validOptionalWarningString(value: unknown): boolean {
  return value === undefined || validWarningString(value);
}

export function validWarning(value: unknown): boolean {
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

export function validResultHeaders(value: unknown): boolean {
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

export function validGenerateMetadata(
  result: Record<string, unknown>
): boolean {
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

export function validateUsage(value: unknown): boolean {
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

export function validGeneratedFileData(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (data.type === "data") {
    return typeof data.data === "string" || isUint8ArrayValue(data.data);
  }
  return data.type === "url" && isUrlValue(data.url);
}

export function validContentPart(record: Record<string, unknown>): boolean {
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

export function validateContent(value: unknown): string | undefined {
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

export function validateGenerateEnvelope(value: unknown): string | undefined {
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
