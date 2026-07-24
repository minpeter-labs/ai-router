import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import {
  MAX_GENERATE_CONTENT_PARTS,
  MAX_RESULT_WARNINGS,
} from "./router-generate-validation";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";

export const GENERATE_ENVELOPE_FIELDS = [
  "content",
  "finishReason",
  "providerMetadata",
  "request",
  "response",
  "usage",
  "warnings",
] as const;

export const GENERATE_CONTENT_MUTATION_FIELDS = [
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
export const MAX_VALIDATOR_MUTATION_FIELDS = 200_000;

export interface ValidatorMutationTarget {
  keys: string[];
  value: object;
}

export function validatorMutationKeys(
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

export function validatorOwnDataValue(
  value: object,
  key: string | number
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return;
  }
}

export function consumeValidatorArrayItemPromises(
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

export function consumeNestedValidatorInputPromiseMutations(
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

export function captureValidatorMutationTargets(
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

export function consumeCapturedValidatorMutationPromises(
  targets: ValidatorMutationTarget[]
): void {
  for (const target of targets) {
    consumeOwnDataPromiseFields(target.value, target.keys);
  }
}

export class InvalidProviderModelError extends Error {
  readonly code = "invalid_provider_model";

  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderModelError";
  }
}

/** A successful generate call must contain something usable by the caller. */
export function hasOutputContent(
  result: LanguageModelV4GenerateResult
): boolean {
  return result.content.some((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return part.text.trim().length > 0;
    }
    // Tool calls and future non-text output types are meaningful payloads.
    return true;
  });
}
