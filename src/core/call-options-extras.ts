import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { synchronousCallField } from "./call-options-output";
import {
  type CallJsonBudget,
  clonePresentJson,
  cloneRequiredJson,
  MAX_CALL_METADATA_CHARACTERS,
  MAX_METADATA_FIELD_LENGTH,
  MAX_REQUEST_HEADER_CHARS,
  MAX_REQUEST_HEADERS,
} from "./call-options-primitives";
import {
  boundedEnumerableOwnKeys,
  hasInvalidHttpHeaderValueCharacter,
  isValidHttpHeaderName,
} from "./http-headers";
import {
  consumeOwnDataPromiseFields,
  isBoundedIdentifier,
  isDottedIdentifier,
} from "./runtime-types";
export function cloneHeaders(
  value: LanguageModelV4CallOptions["headers"]
): typeof value {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("headers must be an object");
  }
  const keys = boundedEnumerableOwnKeys(value, MAX_REQUEST_HEADERS);
  if (keys === undefined) {
    throw new Error(
      `headers must contain at most ${MAX_REQUEST_HEADERS} entries`
    );
  }
  consumeOwnDataPromiseFields(value, keys);
  const headers: Record<string, string | undefined> = {};
  let totalChars = 0;
  for (const key of keys) {
    if (!isValidHttpHeaderName(key)) {
      throw new Error("header names and values must use valid HTTP syntax");
    }
    const item = synchronousCallField(value, key, "header value");
    if (
      item !== undefined &&
      (typeof item !== "string" ||
        item.length > 65_536 ||
        hasInvalidHttpHeaderValueCharacter(item))
    ) {
      throw new Error("header names and values must use valid HTTP syntax");
    }
    totalChars += key.length + (item?.length ?? 0);
    if (totalChars > MAX_REQUEST_HEADER_CHARS) {
      throw new Error("request headers exceed the aggregate size limit");
    }
    Object.defineProperty(headers, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return headers;
}

export function cloneTool(
  tool: NonNullable<LanguageModelV4CallOptions["tools"]>[number],
  budget: CallJsonBudget
): typeof tool {
  consumeOwnDataPromiseFields(tool, [
    "args",
    "description",
    "id",
    "inputExamples",
    "inputSchema",
    "name",
    "providerOptions",
    "strict",
    "type",
  ]);
  const type = synchronousCallField(tool, "type", "tool type");
  const name = synchronousCallField(tool, "name", "tool name");
  if (type === "function") {
    const description = synchronousCallField(
      tool,
      "description",
      "tool description"
    );
    const strict = synchronousCallField(tool, "strict", "tool strict");
    if (
      !isBoundedIdentifier(name) ||
      (description !== undefined && typeof description !== "string") ||
      (strict !== undefined && typeof strict !== "boolean")
    ) {
      throw new Error("function tool has an invalid shape");
    }
    return {
      description,
      inputExamples: cloneRequiredJson(
        synchronousCallField(tool, "inputExamples", "tool inputExamples"),
        "tool.inputExamples",
        budget
      ),
      inputSchema: clonePresentJson(
        synchronousCallField(tool, "inputSchema", "tool inputSchema"),
        "tool.inputSchema",
        budget
      ),
      name,
      providerOptions: cloneRequiredJson(
        synchronousCallField(tool, "providerOptions", "tool providerOptions"),
        "tool.providerOptions",
        budget
      ),
      strict,
      type,
    } as typeof tool;
  }
  const id = synchronousCallField(tool, "id", "provider tool id");
  const args = synchronousCallField(tool, "args", "provider tool args");
  if (
    type !== "provider" ||
    !isDottedIdentifier(id) ||
    !isBoundedIdentifier(name) ||
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args)
  ) {
    throw new Error("provider tool has an invalid shape");
  }
  return {
    args: cloneRequiredJson(args, "provider tool args", budget),
    id,
    name,
    type,
  } as typeof tool;
}

export function validateToolConfiguration(
  tools: LanguageModelV4CallOptions["tools"],
  toolChoice: LanguageModelV4CallOptions["toolChoice"]
): void {
  if (tools === undefined) {
    if (toolChoice?.type === "tool") {
      throw new Error("toolChoice requires a matching tool definition");
    }
    return;
  }
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error("tool names must be unique within a call");
    }
    names.add(tool.name);
  }
  if (toolChoice?.type === "tool" && !names.has(toolChoice.toolName)) {
    throw new Error("toolChoice requires a matching tool definition");
  }
}

export function validateCallMetadataStrings(
  options: LanguageModelV4CallOptions
): void {
  let remaining = MAX_CALL_METADATA_CHARACTERS;
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
      throw new Error("call metadata strings must be non-empty and bounded");
    }
    remaining -= value.length;
    if (remaining < 0) {
      throw new Error("call metadata strings exceed the aggregate size limit");
    }
  };
  const consumeFileData = (value: unknown) => {
    if (typeof value !== "object" || value === null) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type !== "reference") {
      return;
    }
    const reference = record.reference;
    if (typeof reference !== "object" || reference === null) {
      return;
    }
    for (const [provider, id] of Object.entries(reference)) {
      consume(provider, 256, false);
      consume(id, MAX_METADATA_FIELD_LENGTH, false);
    }
  };
  const consumeToolOutput = (value: unknown) => {
    if (typeof value !== "object" || value === null) {
      return;
    }
    const output = value as Record<string, unknown>;
    if (output.type === "execution-denied") {
      consume(output.reason);
      return;
    }
    if (output.type !== "content" || !Array.isArray(output.value)) {
      return;
    }
    for (const nested of output.value) {
      if (typeof nested !== "object" || nested === null) {
        continue;
      }
      const part = nested as Record<string, unknown>;
      if (part.type === "file") {
        consume(part.mediaType, 256, false);
        consume(part.filename);
        consumeFileData(part.data);
      }
    }
  };
  if (options.responseFormat?.type === "json") {
    consume(options.responseFormat.name, 4096);
    consume(options.responseFormat.description);
  }
  for (const tool of options.tools ?? []) {
    consume(tool.name, 4096);
    if (tool.type === "function") {
      consume(tool.description);
    } else {
      consume(tool.id, 4096);
    }
  }
  if (options.toolChoice?.type === "tool") {
    consume(options.toolChoice.toolName, 4096);
  }
  for (const message of options.prompt) {
    if (message.role === "system") {
      continue;
    }
    for (const part of message.content) {
      const record = part as unknown as Record<string, unknown>;
      switch (part.type) {
        case "file":
        case "reasoning-file":
          consume(record.mediaType, 256, false);
          consume(record.filename);
          consumeFileData(record.data);
          break;
        case "custom":
          consume(record.kind, 4096);
          break;
        case "tool-call":
          consume(record.toolCallId, 4096);
          consume(record.toolName, 4096);
          break;
        case "tool-result":
          consume(record.toolCallId, 4096);
          consume(record.toolName, 4096);
          consumeToolOutput(record.output);
          break;
        case "tool-approval-response":
          consume(record.approvalId, 4096);
          consume(record.reason);
          break;
        default:
          break;
      }
    }
  }
}
