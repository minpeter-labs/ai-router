import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { captureAbortSignalOperations } from "./abort-signal";
import {
  type CallJsonBudget,
  clonePresentJson,
  cloneRequiredJson,
  MAX_MESSAGE_PARTS,
  snapshotDenseBounded,
} from "./call-options-primitives";
import { clonePromptPart } from "./call-options-prompt";
import { boundedEnumerableOwnKeys } from "./http-headers";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  isBoundedIdentifier,
  isUint8ArrayValue,
  isUrlValue,
} from "./runtime-types";
export function cloneResponseFormat(
  value: LanguageModelV4CallOptions["responseFormat"],
  budget: CallJsonBudget
): typeof value {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("responseFormat must be an object");
  }
  consumeOwnDataPromiseFields(value, ["description", "name", "schema", "type"]);
  const type = Reflect.get(value, "type");
  if (consumeGenuinePromise(type)) {
    throw new Error("responseFormat must be synchronous");
  }
  if (type === "text") {
    return { type: "text" };
  }
  if (type !== "json") {
    throw new Error("responseFormat has an unknown type");
  }
  const name = Reflect.get(value, "name");
  const description = Reflect.get(value, "description");
  const schema = Reflect.get(value, "schema");
  let asyncField = false;
  for (const field of [name, description, schema]) {
    if (consumeGenuinePromise(field)) {
      asyncField = true;
    }
  }
  if (asyncField) {
    throw new Error("responseFormat fields must be synchronous");
  }
  if (
    (name !== undefined && typeof name !== "string") ||
    (description !== undefined && typeof description !== "string")
  ) {
    throw new Error("responseFormat name and description must be strings");
  }
  return {
    description,
    name,
    schema: cloneRequiredJson(schema, "responseFormat.schema", budget),
    type,
  };
}

export function cloneToolChoice(
  value: LanguageModelV4CallOptions["toolChoice"]
): typeof value {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("toolChoice must be an object");
  }
  consumeOwnDataPromiseFields(value, ["toolName", "type"]);
  const type = Reflect.get(value, "type");
  if (consumeGenuinePromise(type)) {
    throw new Error("toolChoice must be synchronous");
  }
  if (type === "auto" || type === "none" || type === "required") {
    return { type };
  }
  const toolName = Reflect.get(value, "toolName");
  if (consumeGenuinePromise(toolName)) {
    throw new Error("toolChoice fields must be synchronous");
  }
  if (type !== "tool" || !isBoundedIdentifier(toolName)) {
    throw new Error("toolChoice has an invalid shape");
  }
  return { toolName, type };
}

export function validateAbortSignal(
  value: unknown
): asserts value is AbortSignal | undefined {
  if (value === undefined) {
    return;
  }
  captureAbortSignalOperations(value);
  if (typeof value !== "object" || value === null) {
    throw new Error("abortSignal must implement AbortSignal");
  }
  const aborted = Reflect.get(value, "aborted");
  if (consumeGenuinePromise(aborted) || typeof aborted !== "boolean") {
    throw new Error("abortSignal must implement AbortSignal");
  }
}

export function synchronousCallField(
  value: object,
  key: string | number,
  name = "call option field"
): unknown {
  const field = Reflect.get(value, key);
  if (consumeGenuinePromise(field)) {
    throw new Error(`${name} must be synchronous`);
  }
  return field;
}

export function cloneProviderReference(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("file reference must be an object");
  }
  const keys = boundedEnumerableOwnKeys(value, 128);
  if (keys === undefined) {
    throw new Error("file reference has too many providers");
  }
  consumeOwnDataPromiseFields(value, keys);
  const reference: Record<string, string> = {};
  for (const key of keys) {
    const id = synchronousCallField(value, key, "file reference value");
    if (key === "type" || typeof id !== "string") {
      throw new Error("file reference values must be strings");
    }
    Object.defineProperty(reference, key, {
      configurable: true,
      enumerable: true,
      value: id,
      writable: true,
    });
  }
  return reference;
}

export function cloneFileData(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    throw new Error("file data must be a tagged object");
  }
  consumeOwnDataPromiseFields(value, [
    "data",
    "reference",
    "text",
    "type",
    "url",
  ]);
  const type = synchronousCallField(value, "type", "file data type");
  if (type === "data") {
    const data = synchronousCallField(value, "data", "file data payload");
    if (typeof data !== "string" && !isUint8ArrayValue(data)) {
      throw new Error("file data payload must be bytes or a string");
    }
    return { data, type };
  }
  if (type === "url") {
    const url = synchronousCallField(value, "url", "file URL payload");
    if (!isUrlValue(url)) {
      throw new Error("file URL payload must be a URL");
    }
    return { type, url };
  }
  if (type === "reference") {
    return {
      reference: cloneProviderReference(
        synchronousCallField(value, "reference", "file reference")
      ),
      type,
    };
  }
  if (type === "text") {
    const text = synchronousCallField(value, "text", "inline file text");
    if (typeof text !== "string") {
      throw new Error("inline file text must be a string");
    }
    return { text, type };
  }
  throw new Error("file data has an unknown type");
}

export function cloneToolOutput(
  value: unknown,
  budget: CallJsonBudget
): unknown {
  if (typeof value !== "object" || value === null) {
    throw new Error("tool output must be an object");
  }
  consumeOwnDataPromiseFields(value, [
    "providerOptions",
    "reason",
    "type",
    "value",
  ]);
  const type = synchronousCallField(value, "type", "tool output type");
  const providerOptions = cloneRequiredJson(
    synchronousCallField(
      value,
      "providerOptions",
      "tool output providerOptions"
    ),
    "tool output providerOptions",
    budget
  );
  if (type === "text" || type === "error-text") {
    const text = synchronousCallField(value, "value", "tool output value");
    if (typeof text !== "string") {
      throw new Error("text tool output value must be a string");
    }
    return { providerOptions, type, value: text };
  }
  if (type === "json" || type === "error-json") {
    return {
      providerOptions,
      type,
      value: clonePresentJson(
        synchronousCallField(value, "value", "tool output value"),
        "tool output value",
        budget
      ),
    };
  }
  if (type === "execution-denied") {
    const reason = synchronousCallField(value, "reason", "tool output reason");
    if (reason !== undefined && typeof reason !== "string") {
      throw new Error("execution denial reason must be a string");
    }
    return { providerOptions, reason, type };
  }
  if (type === "content") {
    const content = snapshotDenseBounded<unknown>(
      synchronousCallField(value, "value", "tool output content"),
      MAX_MESSAGE_PARTS,
      "tool output content"
    );
    return {
      providerOptions,
      type,
      value: content.map((part) => cloneToolOutputContentPart(part, budget)),
    };
  }
  throw new Error("tool output has an unknown type");
}

export function cloneToolOutputContentPart(
  part: unknown,
  budget: CallJsonBudget
): unknown {
  if (typeof part !== "object" || part === null) {
    throw new Error("tool output content parts must be objects");
  }
  consumeOwnDataPromiseFields(part, ["providerOptions", "type"]);
  const type = synchronousCallField(part, "type", "tool output content type");
  if (type === "text" || type === "file") {
    return clonePromptPart(part, "user", budget);
  }
  if (type === "custom") {
    return {
      providerOptions: cloneRequiredJson(
        synchronousCallField(
          part,
          "providerOptions",
          "tool output custom providerOptions"
        ),
        "tool output custom providerOptions",
        budget
      ),
      type,
    };
  }
  throw new Error("tool output content part has an unknown type");
}
