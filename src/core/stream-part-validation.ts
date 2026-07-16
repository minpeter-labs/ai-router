import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  isBoundedIdentifier,
  isDateValue,
  isDottedIdentifier,
  isUint8ArrayValue,
  isUrlValue,
} from "./runtime-types";

/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */

import {
  FINISH_REASONS,
  MAX_STREAM_METADATA_FIELD_LENGTH,
  MAX_STREAM_WARNING_FIELD_LENGTH,
  PROVIDER_METADATA_PARTS,
} from "./stream-part-fields";
import type { StreamJsonBudget } from "./stream-part-json";
export function validStreamFileData(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const data = value as Record<string, unknown>;
  if (data.type === "data") {
    return typeof data.data === "string" || isUint8ArrayValue(data.data);
  }
  return data.type === "url" && isUrlValue(data.url);
}

export function validUsageNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

export function validOptionalDate(value: unknown): boolean {
  return value === undefined || isDateValue(value);
}

export function validOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function validOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

export function validStreamWarningString(value: unknown): boolean {
  return (
    typeof value === "string" && value.length <= MAX_STREAM_WARNING_FIELD_LENGTH
  );
}

export function validWarning(value: unknown): boolean {
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

export function validFinishPart(part: LanguageModelV4StreamPart): boolean {
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

export function validKnownStreamPartShape(
  part: LanguageModelV4StreamPart
): boolean {
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

export function consumeStreamMetadataStrings(
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
