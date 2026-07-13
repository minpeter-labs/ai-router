import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { captureAbortSignalOperations } from "./abort-signal";
import {
  boundedEnumerableOwnKeys,
  hasInvalidHttpHeaderValueCharacter,
  isValidHttpHeaderName,
} from "./http-headers";
import { snapshotJsonValue } from "./json-value";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  isBoundedIdentifier,
  isDottedIdentifier,
  isUint8ArrayValue,
  isUrlValue,
} from "./runtime-types";

const MAX_PROMPT_MESSAGES = 10_000;
const MAX_MESSAGE_PARTS = 10_000;
const MAX_TOOLS = 1024;
const MAX_STOP_SEQUENCES = 1024;
const MAX_STOP_SEQUENCE_LENGTH = 65_536;
const MAX_STOP_SEQUENCE_CHARS = 1_048_576;
const MAX_REQUEST_HEADERS = 1024;
const MAX_REQUEST_HEADER_CHARS = 1_048_576;
const MAX_CALL_JSON_CONTAINERS = 50_000;
const MAX_CALL_JSON_CHARACTERS = 4_194_304;
const MAX_CALL_METADATA_CHARACTERS = 4_194_304;
const MAX_METADATA_FIELD_LENGTH = 65_536;
const CALL_OPTION_FIELD_KEYS = [
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
const REASONING_VALUES = new Set([
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function snapshotDenseBounded<T>(
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

function consumeBoundedArrayPromiseItems(
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

interface CallJsonBudget {
  remaining: number;
  remainingCharacters: number;
}

function cloneRequiredJson<T>(
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

function clonePresentJson<T>(
  value: T,
  name: string,
  budget: CallJsonBudget
): T {
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return cloneRequiredJson(value, name, budget);
}

function validateOptionalFinite(value: unknown, name: string): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error(`${name} must be a finite number`);
  }
}

function validateScalarOptions(options: LanguageModelV4CallOptions): void {
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

function cloneResponseFormat(
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

function cloneToolChoice(
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

function validateAbortSignal(
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

function synchronousCallField(
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

function cloneProviderReference(value: unknown): Record<string, string> {
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

function cloneFileData(value: unknown): unknown {
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

function cloneToolOutput(value: unknown, budget: CallJsonBudget): unknown {
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

function cloneToolOutputContentPart(
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

type PromptRole = "assistant" | "tool" | "user";

function cloneTextOrReasoningPart<T>(
  record: Record<string, unknown>,
  role: PromptRole,
  type: "reasoning" | "text",
  providerOptions: unknown
): T {
  if (role === "tool" || (type === "reasoning" && role !== "assistant")) {
    throw new Error("text or reasoning part is not allowed for this role");
  }
  const text = synchronousCallField(record, "text", "prompt part text");
  if (typeof text !== "string") {
    throw new Error("text and reasoning content must be strings");
  }
  return { providerOptions, text, type } as T;
}

function cloneFilePart<T>(
  record: Record<string, unknown>,
  role: PromptRole,
  type: "file" | "reasoning-file",
  providerOptions: unknown
): T {
  if (role === "tool" || (type === "reasoning-file" && role !== "assistant")) {
    throw new Error("file part is not allowed for this role");
  }
  const mediaType = synchronousCallField(
    record,
    "mediaType",
    "file part mediaType"
  );
  const filename = synchronousCallField(
    record,
    "filename",
    "file part filename"
  );
  if (
    typeof mediaType !== "string" ||
    (filename !== undefined && typeof filename !== "string")
  ) {
    throw new Error("file mediaType and filename are malformed");
  }
  const data = cloneFileData(
    synchronousCallField(record, "data", "file part data")
  );
  const dataType =
    typeof data === "object" && data !== null
      ? Reflect.get(data, "type")
      : undefined;
  if (type === "reasoning-file" && dataType !== "data" && dataType !== "url") {
    throw new Error("reasoning files require data or URL payloads");
  }
  return {
    data,
    filename,
    mediaType,
    providerOptions,
    type,
  } as T;
}

function cloneCustomPart<T>(
  record: Record<string, unknown>,
  role: PromptRole,
  providerOptions: unknown
): T {
  const kind = synchronousCallField(record, "kind", "custom part kind");
  if (role !== "assistant" || !isDottedIdentifier(kind)) {
    throw new Error("custom parts require an assistant message and kind");
  }
  return { kind, providerOptions, type: "custom" } as T;
}

function cloneToolCallPart<T>(
  record: Record<string, unknown>,
  role: PromptRole,
  providerOptions: unknown,
  budget: CallJsonBudget
): T {
  if (role !== "assistant") {
    throw new Error("tool calls require an assistant message");
  }
  const toolCallId = synchronousCallField(record, "toolCallId", "tool call id");
  const toolName = synchronousCallField(record, "toolName", "tool call name");
  const providerExecuted = synchronousCallField(
    record,
    "providerExecuted",
    "tool call providerExecuted"
  );
  if (
    !(isBoundedIdentifier(toolCallId) && isBoundedIdentifier(toolName)) ||
    (providerExecuted !== undefined && typeof providerExecuted !== "boolean")
  ) {
    throw new Error("tool call fields are malformed");
  }
  return {
    input: clonePresentJson(
      synchronousCallField(record, "input", "tool call input"),
      "tool call input",
      budget
    ),
    providerExecuted,
    providerOptions,
    toolCallId,
    toolName,
    type: "tool-call",
  } as T;
}

function cloneToolResultPart<T>(
  record: Record<string, unknown>,
  role: PromptRole,
  providerOptions: unknown,
  budget: CallJsonBudget
): T {
  if (role === "user") {
    throw new Error("tool results require assistant or tool messages");
  }
  const toolCallId = synchronousCallField(
    record,
    "toolCallId",
    "tool result id"
  );
  const toolName = synchronousCallField(record, "toolName", "tool result name");
  if (!(isBoundedIdentifier(toolCallId) && isBoundedIdentifier(toolName))) {
    throw new Error("tool result identifiers are malformed");
  }
  return {
    output: cloneToolOutput(
      synchronousCallField(record, "output", "tool result output"),
      budget
    ),
    providerOptions,
    toolCallId,
    toolName,
    type: "tool-result",
  } as T;
}

function cloneToolApprovalPart<T>(
  record: Record<string, unknown>,
  role: PromptRole,
  providerOptions: unknown
): T {
  const approvalId = synchronousCallField(
    record,
    "approvalId",
    "tool approval id"
  );
  const approved = synchronousCallField(
    record,
    "approved",
    "tool approval state"
  );
  const reason = synchronousCallField(record, "reason", "tool approval reason");
  if (
    role !== "tool" ||
    !isBoundedIdentifier(approvalId) ||
    typeof approved !== "boolean" ||
    (reason !== undefined && typeof reason !== "string")
  ) {
    throw new Error("tool approval response fields are malformed");
  }
  return {
    approvalId,
    approved,
    providerOptions,
    reason,
    type: "tool-approval-response",
  } as T;
}

function clonePromptPart<T>(
  part: T,
  role: PromptRole,
  budget: CallJsonBudget
): T {
  if (typeof part !== "object" || part === null) {
    throw new Error("prompt content parts must be objects");
  }
  const record = part as Record<string, unknown>;
  consumeOwnDataPromiseFields(record, [
    "approvalId",
    "approved",
    "data",
    "filename",
    "input",
    "kind",
    "mediaType",
    "output",
    "providerExecuted",
    "providerOptions",
    "reason",
    "text",
    "toolCallId",
    "toolName",
    "type",
  ]);
  const type = synchronousCallField(record, "type", "prompt part type");
  const providerOptions = cloneRequiredJson(
    synchronousCallField(record, "providerOptions", "part.providerOptions"),
    "part.providerOptions",
    budget
  );
  if (type === "text" || type === "reasoning") {
    return cloneTextOrReasoningPart(record, role, type, providerOptions);
  }
  if (type === "file" || type === "reasoning-file") {
    return cloneFilePart(record, role, type, providerOptions);
  }
  if (type === "custom") {
    return cloneCustomPart(record, role, providerOptions);
  }
  if (type === "tool-call") {
    return cloneToolCallPart(record, role, providerOptions, budget);
  }
  if (type === "tool-result") {
    return cloneToolResultPart(record, role, providerOptions, budget);
  }
  if (type === "tool-approval-response") {
    return cloneToolApprovalPart(record, role, providerOptions);
  }
  throw new Error("prompt content part has an unknown type");
}

function clonePromptMessage(
  message: LanguageModelV4Prompt[number],
  budget: CallJsonBudget
): LanguageModelV4Prompt[number] {
  if (typeof message !== "object" || message === null) {
    throw new Error("prompt messages must be objects");
  }
  consumeOwnDataPromiseFields(message, ["content", "providerOptions", "role"]);
  const role = synchronousCallField(message, "role", "message role");
  const rawContent = synchronousCallField(
    message,
    "content",
    "message content"
  );
  const providerOptions = cloneRequiredJson(
    synchronousCallField(message, "providerOptions", "message.providerOptions"),
    "message.providerOptions",
    budget
  );
  if (role === "system") {
    if (typeof rawContent !== "string") {
      throw new Error("system message content must be a string");
    }
    return {
      content: rawContent,
      providerOptions,
      role,
    } as LanguageModelV4Prompt[number];
  }
  if (role !== "user" && role !== "assistant" && role !== "tool") {
    throw new Error("prompt message has an unknown role");
  }
  const content = snapshotDenseBounded<unknown>(
    rawContent,
    MAX_MESSAGE_PARTS,
    "message content"
  );
  return {
    content: content.map((part) => clonePromptPart(part, role, budget)),
    providerOptions,
    role,
  } as LanguageModelV4Prompt[number];
}

function clonePrompt(
  prompt: LanguageModelV4Prompt,
  budget: CallJsonBudget
): LanguageModelV4Prompt {
  return snapshotDenseBounded<LanguageModelV4Prompt[number]>(
    prompt,
    MAX_PROMPT_MESSAGES,
    "prompt"
  ).map((message) => clonePromptMessage(message, budget));
}

function cloneHeaders(
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

function cloneTool(
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

function validateToolConfiguration(
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

function validateCallMetadataStrings(
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

export class CallOptionsContractError extends Error {
  readonly code = "call_options_contract_error";

  constructor(cause: unknown) {
    super("ai-router: call options could not be safely copied", { cause });
    this.name = "CallOptionsContractError";
  }
}

function consumeCallOptionPromiseFields(
  source: LanguageModelV4CallOptions
): void {
  consumeBoundedArrayPromiseItems(source.prompt, MAX_PROMPT_MESSAGES);
  consumeBoundedArrayPromiseItems(source.stopSequences, MAX_STOP_SEQUENCES);
  consumeBoundedArrayPromiseItems(source.tools, MAX_TOOLS);
  if (
    typeof source.responseFormat === "object" &&
    source.responseFormat !== null
  ) {
    consumeOwnDataPromiseFields(source.responseFormat, [
      "description",
      "name",
      "schema",
      "type",
    ]);
  }
  if (typeof source.toolChoice === "object" && source.toolChoice !== null) {
    consumeOwnDataPromiseFields(source.toolChoice, ["toolName", "type"]);
  }
  let asyncField = false;
  for (const value of Object.values(source)) {
    if (consumeGenuinePromise(value)) {
      asyncField = true;
    }
  }
  if (asyncField) {
    throw new Error("call options fields must be synchronous");
  }
}

function cloneCallOptionsUnsafe(
  options: LanguageModelV4CallOptions,
  abortSignal: AbortSignal | undefined
): LanguageModelV4CallOptions {
  if (consumeGenuinePromise(options)) {
    throw new Error("call options must be synchronous");
  }
  consumeOwnDataPromiseFields(options, CALL_OPTION_FIELD_KEYS);
  const source: LanguageModelV4CallOptions = {
    abortSignal,
    frequencyPenalty: Reflect.get(options, "frequencyPenalty"),
    headers: Reflect.get(options, "headers"),
    includeRawChunks: Reflect.get(options, "includeRawChunks"),
    maxOutputTokens: Reflect.get(options, "maxOutputTokens"),
    presencePenalty: Reflect.get(options, "presencePenalty"),
    prompt: Reflect.get(options, "prompt"),
    providerOptions: Reflect.get(options, "providerOptions"),
    reasoning: Reflect.get(options, "reasoning"),
    responseFormat: Reflect.get(options, "responseFormat"),
    seed: Reflect.get(options, "seed"),
    stopSequences: Reflect.get(options, "stopSequences"),
    temperature: Reflect.get(options, "temperature"),
    toolChoice: Reflect.get(options, "toolChoice"),
    tools: Reflect.get(options, "tools"),
    topK: Reflect.get(options, "topK"),
    topP: Reflect.get(options, "topP"),
  };
  consumeCallOptionPromiseFields(source);
  validateAbortSignal(abortSignal);
  validateScalarOptions(source);
  const jsonBudget = {
    remaining: MAX_CALL_JSON_CONTAINERS,
    remainingCharacters: MAX_CALL_JSON_CHARACTERS,
  };
  const stopSequences =
    source.stopSequences === undefined
      ? undefined
      : snapshotDenseBounded<unknown>(
          source.stopSequences,
          MAX_STOP_SEQUENCES,
          "stopSequences"
        );
  if (stopSequences !== undefined) {
    let totalChars = 0;
    for (const value of stopSequences) {
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_STOP_SEQUENCE_LENGTH
      ) {
        throw new Error("stopSequences must contain bounded non-empty strings");
      }
      totalChars += value.length;
      if (totalChars > MAX_STOP_SEQUENCE_CHARS) {
        throw new Error("stopSequences exceed the aggregate size limit");
      }
    }
  }
  const rawTools =
    source.tools === undefined
      ? undefined
      : snapshotDenseBounded<unknown>(source.tools, MAX_TOOLS, "tools");
  if (
    rawTools !== undefined &&
    !rawTools.every((tool) => typeof tool === "object" && tool !== null)
  ) {
    throw new Error("tools must contain objects");
  }
  const tools = rawTools?.map((tool) =>
    cloneTool(
      tool as NonNullable<LanguageModelV4CallOptions["tools"]>[number],
      jsonBudget
    )
  );
  const toolChoice = cloneToolChoice(source.toolChoice);
  validateToolConfiguration(tools, toolChoice);
  const cloned = {
    ...source,
    abortSignal,
    headers: cloneHeaders(source.headers),
    prompt: clonePrompt(source.prompt, jsonBudget),
    providerOptions: cloneRequiredJson(
      source.providerOptions,
      "providerOptions",
      jsonBudget
    ),
    responseFormat: cloneResponseFormat(source.responseFormat, jsonBudget),
    stopSequences: stopSequences as string[] | undefined,
    toolChoice,
    tools,
  };
  validateCallMetadataStrings(cloned);
  return cloned;
}

/** Isolate mutable option containers for one provider attempt. */
export function cloneCallOptions(
  options: LanguageModelV4CallOptions,
  abortSignal: AbortSignal | undefined
): LanguageModelV4CallOptions {
  try {
    return cloneCallOptionsUnsafe(options, abortSignal);
  } catch (error) {
    throw new CallOptionsContractError(error);
  }
}

/** Capture the caller-owned signal inside the same contract-error boundary. */
export function cloneInitialCallOptions(
  options: LanguageModelV4CallOptions
): LanguageModelV4CallOptions {
  try {
    if (consumeGenuinePromise(options)) {
      throw new Error("call options must be synchronous");
    }
    consumeOwnDataPromiseFields(options, [
      "abortSignal",
      ...CALL_OPTION_FIELD_KEYS,
    ]);
    return cloneCallOptionsUnsafe(
      options,
      synchronousCallField(options, "abortSignal", "abortSignal") as
        | AbortSignal
        | undefined
    );
  } catch (error) {
    if (error instanceof CallOptionsContractError) {
      throw error;
    }
    throw new CallOptionsContractError(error);
  }
}
