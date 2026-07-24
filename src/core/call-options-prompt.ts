import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import {
  cloneFileData,
  cloneToolOutput,
  synchronousCallField,
} from "./call-options-output";
import {
  type CallJsonBudget,
  clonePresentJson,
  cloneRequiredJson,
  MAX_MESSAGE_PARTS,
  MAX_PROMPT_MESSAGES,
  snapshotDenseBounded,
} from "./call-options-primitives";
import {
  consumeOwnDataPromiseFields,
  isBoundedIdentifier,
  isDottedIdentifier,
} from "./runtime-types";
export type PromptRole = "assistant" | "tool" | "user";

export function cloneTextOrReasoningPart<T>(
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

export function cloneFilePart<T>(
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

export function cloneCustomPart<T>(
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

export function cloneToolCallPart<T>(
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

export function cloneToolResultPart<T>(
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

export function cloneToolApprovalPart<T>(
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

export function clonePromptPart<T>(
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

export function clonePromptMessage(
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

export function clonePrompt(
  prompt: LanguageModelV4Prompt,
  budget: CallJsonBudget
): LanguageModelV4Prompt {
  return snapshotDenseBounded<LanguageModelV4Prompt[number]>(
    prompt,
    MAX_PROMPT_MESSAGES,
    "prompt"
  ).map((message) => clonePromptMessage(message, budget));
}
