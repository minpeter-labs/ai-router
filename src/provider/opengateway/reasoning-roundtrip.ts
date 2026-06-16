import type { JSONValue, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";
import {
  appendUniqueJsonDetails,
  collectChoiceReasoningDetails,
} from "./metadata";
import { withReasoningDetailsOnPrompt } from "./reasoning-roundtrip-input";
import {
  withReasoningDetailsOnContent,
  withReasoningPartMetadata,
} from "./reasoning-roundtrip-output";
import {
  createOpenGatewayReasoningDetailsStore,
  createOpenGatewayReasoningDetailsStoreMemo,
  type OpenGatewayReasoningDetailsStore,
} from "./reasoning-roundtrip-store";

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

export interface OpenGatewayReasoningRoundtripMiddlewareSettings {
  reasoningDetailsStore?: OpenGatewayReasoningDetailsStore;
}

export function createOpenGatewayReasoningRoundtripMiddleware({
  reasoningDetailsStore = createOpenGatewayReasoningDetailsStore(),
}: OpenGatewayReasoningRoundtripMiddlewareSettings = {}): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    async transformParams({ params }) {
      return {
        ...params,
        prompt: await withReasoningDetailsOnPrompt(
          params.prompt,
          reasoningDetailsStore
        ),
      };
    },
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      const reasoningDetails = collectChoiceReasoningDetails(
        result.response?.body
      );
      const outputReasoningDetailsStore =
        createOpenGatewayReasoningDetailsStoreMemo(reasoningDetailsStore);
      return {
        ...result,
        content: await withReasoningDetailsOnContent(
          result.content,
          reasoningDetails,
          outputReasoningDetailsStore
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
      const outputReasoningDetailsStore =
        createOpenGatewayReasoningDetailsStoreMemo(reasoningDetailsStore);
      let carriedReasoningDetailsCount = 0;
      let pendingToolCall: LanguageModelV4StreamPart | undefined;

      const enqueuePendingToolCall = async (
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
          await withReasoningPartMetadata(
            pendingToolCall,
            uncarriedReasoningDetails,
            outputReasoningDetailsStore
          )
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
            async transform(part, controller) {
              if (part.type === "raw") {
                appendUniqueJsonDetails(
                  reasoningDetails,
                  collectChoiceReasoningDetails(part.rawValue)
                );
                await enqueuePendingToolCall(controller);
                if (includeRawChunks) {
                  controller.enqueue(part);
                }
                return;
              }

              if (part.type === "tool-call") {
                await enqueuePendingToolCall(controller);
                pendingToolCall = part;
                return;
              }

              await enqueuePendingToolCall(controller);

              if (isReasoningStreamPart(part)) {
                carriedReasoningDetailsCount = reasoningDetails.length;
                controller.enqueue(
                  await withReasoningPartMetadata(
                    part,
                    reasoningDetails,
                    outputReasoningDetailsStore
                  )
                );
                return;
              }

              if (isTextStreamPart(part)) {
                carriedReasoningDetailsCount = reasoningDetails.length;
                controller.enqueue(
                  await withReasoningPartMetadata(
                    part,
                    reasoningDetails,
                    outputReasoningDetailsStore
                  )
                );
                return;
              }

              controller.enqueue(part);
            },
            async flush(controller) {
              await enqueuePendingToolCall(controller);
            },
          })
        ),
      };
    },
  };
}
