import {
  isJSONArray,
  isJSONValue,
  type JSONValue,
  type LanguageModelV4Message,
  type LanguageModelV4Prompt,
  type SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import {
  type OpenGatewayReasoningDetailsStore,
  REASONING_DETAILS_REF_KEY,
} from "./reasoning-roundtrip-store";

const OPENGATEWAY_KEY = "opengateway";
const OPENAI_COMPATIBLE_KEY = "openaiCompatible";
const REASONING_DETAILS_KEY = "reasoningDetails";
const REASONING_DETAILS_REQUEST_KEY = "reasoning_details";

function assertNever(value: never): never {
  throw new TypeError(`Unsupported OpenGateway reasoning variant: ${value}`);
}

function asJsonList(value: JSONValue): JSONValue[] {
  return isJSONArray(value) ? value : [value];
}

function isReasoningDetailsValue(value: unknown): value is JSONValue {
  return value !== null && isJSONValue(value);
}

function jsonValueKey(value: JSONValue): string {
  return JSON.stringify(value) ?? "undefined";
}

function appendUniqueJsonDetails(
  target: JSONValue[],
  details: readonly JSONValue[]
): void {
  const seen = new Set(target.map(jsonValueKey));
  for (const detail of details) {
    const key = jsonValueKey(detail);
    if (!seen.has(key)) {
      seen.add(key);
      target.push(detail);
    }
  }
}

function appendJsonDetails(target: JSONValue[], value: unknown): void {
  if (isReasoningDetailsValue(value)) {
    appendUniqueJsonDetails(target, asJsonList(value));
  }
}

async function appendReasoningDetailsFromOptions(
  target: JSONValue[],
  options: SharedV4ProviderOptions | undefined,
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): Promise<void> {
  const opengateway = options?.[OPENGATEWAY_KEY];
  appendJsonDetails(target, opengateway?.[REASONING_DETAILS_KEY]);
  appendJsonDetails(target, opengateway?.[REASONING_DETAILS_REQUEST_KEY]);
  const ref = opengateway?.[REASONING_DETAILS_REF_KEY];
  if (typeof ref === "string") {
    const details = await reasoningDetailsStore.load(ref);
    if (details != null) {
      appendUniqueJsonDetails(target, details);
    }
  }
}

function hasOpenAICompatibleReasoningDetails(
  options?: SharedV4ProviderOptions
): boolean {
  return isJSONValue(
    options?.[OPENAI_COMPATIBLE_KEY]?.[REASONING_DETAILS_REQUEST_KEY]
  );
}

function withOpenAICompatibleReasoningDetails(
  options: SharedV4ProviderOptions | undefined,
  details: readonly JSONValue[]
): SharedV4ProviderOptions | undefined {
  if (details.length === 0 || hasOpenAICompatibleReasoningDetails(options)) {
    return options;
  }

  return {
    ...(options ?? {}),
    [OPENAI_COMPATIBLE_KEY]: {
      ...(options?.[OPENAI_COMPATIBLE_KEY] ?? {}),
      [REASONING_DETAILS_REQUEST_KEY]: [...details],
    },
  };
}

async function collectMessageReasoningDetails(
  message: LanguageModelV4Message,
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): Promise<JSONValue[]> {
  switch (message.role) {
    case "assistant": {
      const details: JSONValue[] = [];
      await appendReasoningDetailsFromOptions(
        details,
        message.providerOptions,
        reasoningDetailsStore
      );
      for (const part of message.content) {
        await appendReasoningDetailsFromOptions(
          details,
          part.providerOptions,
          reasoningDetailsStore
        );
      }
      return details;
    }
    case "system":
    case "tool":
    case "user":
      return [];
    default:
      return assertNever(message);
  }
}

async function withReasoningDetailsOnMessage(
  message: LanguageModelV4Message,
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): Promise<LanguageModelV4Message> {
  const details = await collectMessageReasoningDetails(
    message,
    reasoningDetailsStore
  );
  if (details.length === 0) {
    return message;
  }

  switch (message.role) {
    case "assistant":
      return {
        ...message,
        providerOptions: withOpenAICompatibleReasoningDetails(
          message.providerOptions,
          details
        ),
      };
    case "system":
    case "tool":
    case "user":
      return message;
    default:
      return assertNever(message);
  }
}

export function withReasoningDetailsOnPrompt(
  prompt: LanguageModelV4Prompt,
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): Promise<LanguageModelV4Prompt> {
  return Promise.all(
    prompt.map((message) =>
      withReasoningDetailsOnMessage(message, reasoningDetailsStore)
    )
  );
}
