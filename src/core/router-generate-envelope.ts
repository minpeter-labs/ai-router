import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { snapshotGenerateContent } from "./router-generate-content";
import {
  ASYNC_GENERATE_FIELD,
  type AsyncGenerateFieldError,
  captureGenerateFields,
  captureGenerateSiblings,
  captureGenerateSiblingValue,
  createGenerateJsonBudget,
  generateDiscriminant,
  generateField,
  snapshotFinishReason,
  snapshotGenerateRequest,
  snapshotGenerateResponse,
  snapshotProviderMetadata,
  snapshotUsage,
  synchronousGenerateValue,
} from "./router-generate-snapshot";
import {
  MAX_GENERATE_METADATA_CHARACTERS,
  MAX_METADATA_FIELD_LENGTH,
  MAX_RESULT_WARNING_CHARS,
  MAX_RESULT_WARNINGS,
} from "./router-generate-validation";
import { GENERATE_ENVELOPE_FIELDS } from "./router-generate-validator";
import { consumeOwnDataPromiseFields } from "./runtime-types";

export function snapshotGenerateWarning(value: unknown): unknown {
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

export function generateWarningCharacters(value: unknown): number {
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

export function snapshotGenerateWarnings(value: unknown): unknown {
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

export function validateGenerateMetadataStrings(
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

export function snapshotGenerateEnvelope(
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

export function discardLateGenerateResult(
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
