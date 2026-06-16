import {
  isJSONArray,
  isJSONValue,
  type JSONValue,
  type LanguageModelV4Message,
  type LanguageModelV4Prompt,
  type LanguageModelV4StreamPart,
  type SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";
import { collectChoiceReasoningDetails } from "./metadata";
import {
  withReasoningDetailsOnContent,
  withReasoningPartMetadata,
} from "./reasoning-roundtrip-output";

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
  if (isJSONValue(value)) {
    appendUniqueJsonDetails(target, asJsonList(value));
  }
}

function appendReasoningDetailsFromOptions(
  target: JSONValue[],
  options?: SharedV4ProviderOptions
): void {
  const opengateway = options?.[OPENGATEWAY_KEY];
  appendJsonDetails(target, opengateway?.[REASONING_DETAILS_KEY]);
  appendJsonDetails(target, opengateway?.[REASONING_DETAILS_REQUEST_KEY]);
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

function collectMessageReasoningDetails(
  message: LanguageModelV4Message
): JSONValue[] {
  switch (message.role) {
    case "assistant": {
      const details: JSONValue[] = [];
      appendReasoningDetailsFromOptions(details, message.providerOptions);
      for (const part of message.content) {
        appendReasoningDetailsFromOptions(details, part.providerOptions);
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

function withReasoningDetailsOnMessage(
  message: LanguageModelV4Message
): LanguageModelV4Message {
  const details = collectMessageReasoningDetails(message);
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

function withReasoningDetailsOnPrompt(
  prompt: LanguageModelV4Prompt
): LanguageModelV4Prompt {
  return prompt.map(withReasoningDetailsOnMessage);
}

function isReasoningStreamPart(part: LanguageModelV4StreamPart): boolean {
  return (
    part.type === "reasoning-delta" ||
    part.type === "reasoning-end" ||
    part.type === "reasoning-start"
  );
}

function isTextStreamPart(part: LanguageModelV4StreamPart): boolean {
  return (
    part.type === "text-delta" ||
    part.type === "text-end" ||
    part.type === "text-start"
  );
}

function detailsSince(
  details: readonly JSONValue[],
  count: number
): readonly JSONValue[] {
  return details.slice(count);
}

export const opengatewayReasoningRoundtripMiddleware: LanguageModelMiddleware =
  {
    specificationVersion: "v4",
    transformParams({ params }) {
      return Promise.resolve({
        ...params,
        prompt: withReasoningDetailsOnPrompt(params.prompt),
      });
    },
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      const reasoningDetails = collectChoiceReasoningDetails(
        result.response?.body
      );
      return {
        ...result,
        content: withReasoningDetailsOnContent(
          result.content,
          reasoningDetails
        ),
      };
    },
    async wrapStream({ model, params }) {
      const includeRawChunks = params.includeRawChunks === true;
      const result = await model.doStream({
        ...params,
        includeRawChunks: true,
      });
      const reasoningDetails: JSONValue[] = [];
      let carriedReasoningDetailsCount = 0;
      let pendingToolCall: LanguageModelV4StreamPart | undefined;

      const enqueuePendingToolCall = (
        controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
      ) => {
        if (pendingToolCall === undefined) {
          return;
        }

        const uncarriedReasoningDetails = detailsSince(
          reasoningDetails,
          carriedReasoningDetailsCount
        );
        carriedReasoningDetailsCount = reasoningDetails.length;
        controller.enqueue(
          withReasoningPartMetadata(pendingToolCall, uncarriedReasoningDetails)
        );
        pendingToolCall = undefined;
      };

      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<
            LanguageModelV4StreamPart,
            LanguageModelV4StreamPart
          >({
            transform(part, controller) {
              if (part.type === "raw") {
                appendUniqueJsonDetails(
                  reasoningDetails,
                  collectChoiceReasoningDetails(part.rawValue)
                );
                enqueuePendingToolCall(controller);
                if (includeRawChunks) {
                  controller.enqueue(part);
                }
                return;
              }

              if (part.type === "tool-call") {
                enqueuePendingToolCall(controller);
                pendingToolCall = part;
                return;
              }

              enqueuePendingToolCall(controller);

              if (isReasoningStreamPart(part)) {
                carriedReasoningDetailsCount = reasoningDetails.length;
                controller.enqueue(
                  withReasoningPartMetadata(part, reasoningDetails)
                );
                return;
              }

              if (isTextStreamPart(part)) {
                const uncarriedReasoningDetails = detailsSince(
                  reasoningDetails,
                  carriedReasoningDetailsCount
                );
                carriedReasoningDetailsCount = reasoningDetails.length;
                controller.enqueue(
                  withReasoningPartMetadata(part, uncarriedReasoningDetails)
                );
                return;
              }

              controller.enqueue(part);
            },
            flush(controller) {
              enqueuePendingToolCall(controller);
            },
          })
        ),
      };
    },
  };
