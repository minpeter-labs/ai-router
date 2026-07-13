import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { snapshotJsonValue } from "./json-value";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";

export const MAX_PROMPT_MESSAGES = 10_000;
export const MAX_MESSAGE_PARTS = 10_000;
export const MAX_TOOLS = 1024;
export const MAX_STOP_SEQUENCES = 1024;
export const MAX_STOP_SEQUENCE_LENGTH = 65_536;
export const MAX_STOP_SEQUENCE_CHARS = 1_048_576;
export const MAX_REQUEST_HEADERS = 1024;
export const MAX_REQUEST_HEADER_CHARS = 1_048_576;
export const MAX_CALL_JSON_CONTAINERS = 50_000;
export const MAX_CALL_JSON_CHARACTERS = 4_194_304;
export const MAX_CALL_METADATA_CHARACTERS = 4_194_304;
export const MAX_METADATA_FIELD_LENGTH = 65_536;
export const CALL_OPTION_FIELD_KEYS = [
  "frequencyPenalty",
  "headers",
  "includeRawChunks",
  "maxOutputTokens",
  "presencePenalty",
  "prompt",
  "providerOptions",
  "reasoning",
  "responseFormat",
  "seed",
  "stopSequences",
  "temperature",
  "toolChoice",
  "tools",
  "topK",
  "topP",
] as const;
export const REASONING_VALUES = new Set([
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export function snapshotDenseBounded<T>(
  value: unknown,
  maximum: number,
  name: string
): T[] {
  if (consumeGenuinePromise(value)) {
    throw new Error(`${name} must be synchronous`);
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `${name} must be a dense array with at most ${maximum} items`
    );
  }
  const length = Reflect.get(value, "length");
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    throw new Error(
      `${name} must be a dense array with at most ${maximum} items`
    );
  }
  consumeOwnDataPromiseFields(
    value,
    Array.from({ length }, (_, index) => index)
  );
  const snapshot = new Array<T>(length);
  let asyncItem = false;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error(
        `${name} must be a dense array with at most ${maximum} items`
      );
    }
    const item = Reflect.get(value, index);
    if (consumeGenuinePromise(item)) {
      asyncItem = true;
    } else {
      snapshot[index] = item as T;
    }
  }
  if (asyncItem) {
    throw new Error(`${name} entries must be synchronous`);
  }
  return snapshot;
}

export function consumeBoundedArrayPromiseItems(
  value: unknown,
  maximum: number
): void {
  try {
    if (!Array.isArray(value)) {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length =
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximum
    ) {
      return;
    }
    consumeOwnDataPromiseFields(
      value,
      Array.from({ length }, (_, index) => index)
    );
  } catch {
    // Malformed Proxy arrays cannot prevent the main bounded validation.
  }
}

export interface CallJsonBudget {
  remaining: number;
  remainingCharacters: number;
}

export function cloneRequiredJson<T>(
  value: T,
  name: string,
  budget?: CallJsonBudget
): T {
  if (value === undefined) {
    return value;
  }
  const snapshot = snapshotJsonValue(
    value,
    budget?.remaining,
    budget?.remainingCharacters
  );
  if (!snapshot.valid) {
    throw new Error(`${name} must be valid bounded JSON`);
  }
  if (budget !== undefined) {
    budget.remaining -= snapshot.containers ?? 0;
    budget.remainingCharacters -= snapshot.characters ?? 0;
  }
  return snapshot.value as T;
}

export function clonePresentJson<T>(
  value: T,
  name: string,
  budget: CallJsonBudget
): T {
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return cloneRequiredJson(value, name, budget);
}

export function validateOptionalFinite(value: unknown, name: string): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error(`${name} must be a finite number`);
  }
}

export function validateScalarOptions(
  options: LanguageModelV4CallOptions
): void {
  for (const name of [
    "temperature",
    "topP",
    "presencePenalty",
    "frequencyPenalty",
  ] as const) {
    validateOptionalFinite(options[name], name);
  }
  for (const name of ["maxOutputTokens", "topK", "seed"] as const) {
    const value = options[name];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value))
    ) {
      throw new Error(`${name} must be a safe integer`);
    }
  }
  if (options.maxOutputTokens !== undefined && options.maxOutputTokens <= 0) {
    throw new Error("maxOutputTokens must be positive");
  }
  if (
    options.includeRawChunks !== undefined &&
    typeof options.includeRawChunks !== "boolean"
  ) {
    throw new Error("includeRawChunks must be a boolean");
  }
  if (
    options.reasoning !== undefined &&
    !REASONING_VALUES.has(options.reasoning)
  ) {
    throw new Error("reasoning has an unknown value");
  }
}
