import type {
  JSONValue,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { isJSONObject } from "@ai-sdk/provider";
import { cloneCallOptions } from "../../core/call-options";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "../../core/runtime-types";
import { clearTimerSafely, scheduleTimer } from "../../core/timeout";
import { appendUniqueJsonDetails } from "./metadata";
import {
  captureOpenGatewayReasoningDetailsStore,
  type OpenGatewayReasoningDetailsStore,
  REASONING_DETAILS_REF_KEY,
} from "./reasoning-roundtrip-store";

const OPENGATEWAY_KEY = "opengateway";
const OPENAI_COMPATIBLE_KEY = "openaiCompatible";
const REASONING_DETAILS_KEY = "reasoningDetails";
const REASONING_DETAILS_REQUEST_KEY = "reasoning_details";
const MAX_PROMPT_REPLAY_CONCURRENCY = 32;
const PROMPT_REPLAY_TIMEOUT_MS = 1000;

function assertNever(value: never): never {
  throw new TypeError(`Unsupported OpenGateway reasoning variant: ${value}`);
}

function appendJsonDetails(target: JSONValue[], value: unknown): void {
  if (value !== null && value !== undefined) {
    appendUniqueJsonDetails(target, Array.isArray(value) ? value : [value]);
  }
}

async function appendReasoningDetailsFromOptions(
  target: JSONValue[],
  options: SharedV4ProviderOptions | undefined,
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): Promise<void> {
  const opengateway = isJSONObject(options?.[OPENGATEWAY_KEY])
    ? options[OPENGATEWAY_KEY]
    : undefined;
  appendJsonDetails(target, opengateway?.[REASONING_DETAILS_KEY]);
  appendJsonDetails(target, opengateway?.[REASONING_DETAILS_REQUEST_KEY]);
  const ref = opengateway?.[REASONING_DETAILS_REF_KEY];
  if (typeof ref === "string") {
    try {
      const details = await reasoningDetailsStore.load(ref);
      if (details != null) {
        appendUniqueJsonDetails(target, details);
      }
    } catch {
      // Persistence is optional; an unavailable ref must not fail the request.
    }
  }
}

function hasOpenAICompatibleReasoningDetails(
  options?: SharedV4ProviderOptions
): boolean {
  const openAICompatible = options?.[OPENAI_COMPATIBLE_KEY];
  const value = isJSONObject(openAICompatible)
    ? openAICompatible[REASONING_DETAILS_REQUEST_KEY]
    : undefined;
  return value !== undefined && value !== null;
}

function withOpenAICompatibleReasoningDetails(
  options: SharedV4ProviderOptions | undefined,
  details: readonly JSONValue[]
): SharedV4ProviderOptions | undefined {
  if (details.length === 0 || hasOpenAICompatibleReasoningDetails(options)) {
    return options;
  }

  const stableOptions = isJSONObject(options) ? options : {};
  const openAICompatible = isJSONObject(stableOptions[OPENAI_COMPATIBLE_KEY])
    ? stableOptions[OPENAI_COMPATIBLE_KEY]
    : {};
  return {
    ...stableOptions,
    [OPENAI_COMPATIBLE_KEY]: {
      ...openAICompatible,
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

export async function withReasoningDetailsOnPrompt(
  prompt: LanguageModelV4Prompt,
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): Promise<LanguageModelV4Prompt> {
  consumeGenuinePromise(prompt);
  consumeGenuinePromise(reasoningDetailsStore);
  if (Array.isArray(prompt)) {
    const length = Reflect.get(prompt, "length");
    if (
      typeof length === "number" &&
      Number.isSafeInteger(length) &&
      length >= 0 &&
      length <= 10_000
    ) {
      consumeOwnDataPromiseFields(
        prompt,
        Array.from({ length }, (_, index) => index)
      );
    }
  }
  if (
    (typeof reasoningDetailsStore === "object" &&
      reasoningDetailsStore !== null) ||
    typeof reasoningDetailsStore === "function"
  ) {
    consumeOwnDataPromiseFields(reasoningDetailsStore, ["load", "store"]);
  }
  const capturedPrompt = cloneCallOptions({ prompt }, undefined).prompt;
  const capturedStore = captureOpenGatewayReasoningDetailsStore(
    reasoningDetailsStore
  );
  const length = capturedPrompt.length;
  const original = new Array<LanguageModelV4Prompt[number]>(length);
  const output = new Array<LanguageModelV4Prompt[number]>(length);
  for (let index = 0; index < length; index += 1) {
    original[index] = capturedPrompt[index];
    output[index] = capturedPrompt[index];
  }
  let nextIndex = 0;
  let stopped = false;
  let timedOut = false;
  const worker = async () => {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= length) {
        return;
      }
      const message = await withReasoningDetailsOnMessage(
        capturedPrompt[index],
        capturedStore
      );
      if (stopped) {
        return;
      }
      output[index] = message;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    try {
      timer = scheduleTimer(() => {
        stopped = true;
        timedOut = true;
        resolve();
      }, PROMPT_REPLAY_TIMEOUT_MS);
    } catch {
      stopped = true;
      timedOut = true;
      resolve();
    }
  });
  const workers = Promise.all(
    Array.from(
      { length: Math.min(length, MAX_PROMPT_REPLAY_CONCURRENCY) },
      worker
    )
  );
  await Promise.race([workers, timeout]);
  stopped = true;
  clearTimerSafely(timer);
  return timedOut ? original : output;
}
