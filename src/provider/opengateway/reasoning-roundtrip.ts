import type { JSONValue, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";
import { snapshotReasoningRequestBody } from "../../core/reasoning";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "../../core/runtime-types";
import {
  appendUniqueJsonDetails,
  collectChoiceReasoningDetails,
} from "./metadata-details";
import { withReasoningDetailsOnPrompt } from "./reasoning-roundtrip-input";
import {
  captureReasoningStreamPart,
  withReasoningDetailsOnContent,
  withReasoningPartMetadata,
} from "./reasoning-roundtrip-output";
import {
  captureMiddlewareHookArgs,
  detailsSince,
  discardReasoningStream,
  isReasoningStreamPart,
  isTextStreamPart,
  snapshotMiddlewareResult,
} from "./reasoning-roundtrip-runtime";
import {
  captureOpenGatewayReasoningDetailsStore,
  createOpenGatewayReasoningDetailsStore,
  createOpenGatewayReasoningDetailsStoreMemo,
  type OpenGatewayReasoningDetailsStore,
} from "./reasoning-roundtrip-store";

export interface OpenGatewayReasoningRoundtripMiddlewareSettings {
  reasoningDetailsStore?: OpenGatewayReasoningDetailsStore;
}

export function createOpenGatewayReasoningRoundtripMiddleware(
  settings: OpenGatewayReasoningRoundtripMiddlewareSettings = {}
): LanguageModelMiddleware {
  if (consumeGenuinePromise(settings)) {
    throw new TypeError("reasoning roundtrip settings must be synchronous");
  }
  if (typeof settings !== "object" || settings === null) {
    throw new TypeError("reasoning roundtrip settings must be an object");
  }
  consumeOwnDataPromiseFields(settings, ["reasoningDetailsStore"]);
  const configuredStore = settings.reasoningDetailsStore;
  if (consumeGenuinePromise(configuredStore)) {
    throw new TypeError("reasoningDetailsStore must be synchronous");
  }
  const reasoningDetailsStore =
    configuredStore === undefined
      ? createOpenGatewayReasoningDetailsStore()
      : configuredStore;
  const capturedReasoningDetailsStore = captureOpenGatewayReasoningDetailsStore(
    reasoningDetailsStore
  );
  return {
    specificationVersion: "v4",
    async transformParams(options) {
      const { params } = captureMiddlewareHookArgs(options) as {
        params: Parameters<
          NonNullable<LanguageModelMiddleware["transformParams"]>
        >[0]["params"];
      };
      const inputReasoningDetailsStore =
        createOpenGatewayReasoningDetailsStoreMemo(
          capturedReasoningDetailsStore
        );
      return {
        ...params,
        prompt: await withReasoningDetailsOnPrompt(
          params.prompt,
          inputReasoningDetailsStore
        ),
      };
    },
    async wrapGenerate(options) {
      const { doGenerate } = captureMiddlewareHookArgs(options) as {
        doGenerate: Parameters<
          NonNullable<LanguageModelMiddleware["wrapGenerate"]>
        >[0]["doGenerate"];
      };
      if (typeof doGenerate !== "function") {
        throw new TypeError(
          "reasoning middleware doGenerate must be a function"
        );
      }
      const result = snapshotMiddlewareResult(
        await doGenerate(),
        "reasoning generate result"
      );
      const response =
        result.response === undefined
          ? undefined
          : snapshotMiddlewareResult(
              result.response,
              "reasoning generate response"
            );
      const reasoningDetails = collectChoiceReasoningDetails(response?.body);
      const outputReasoningDetailsStore =
        createOpenGatewayReasoningDetailsStoreMemo(
          capturedReasoningDetailsStore
        );
      return {
        ...result,
        content: await withReasoningDetailsOnContent(
          result.content as never,
          reasoningDetails,
          outputReasoningDetailsStore
        ),
      } as Awaited<ReturnType<typeof doGenerate>>;
    },
    async wrapStream(options) {
      const { model, params } = captureMiddlewareHookArgs(options) as {
        model: Parameters<
          NonNullable<LanguageModelMiddleware["wrapStream"]>
        >[0]["model"];
        params: Parameters<
          NonNullable<LanguageModelMiddleware["wrapStream"]>
        >[0]["params"];
      };
      if (typeof model !== "object" || model === null) {
        throw new TypeError("reasoning middleware model must be an object");
      }
      consumeOwnDataPromiseFields(model, ["doStream"]);
      const doStream = Reflect.get(model, "doStream");
      if (consumeGenuinePromise(doStream) || typeof doStream !== "function") {
        throw new TypeError(
          "reasoning middleware model.doStream must be a function"
        );
      }
      const capturedParams = snapshotReasoningRequestBody(params);
      const includeRawChunks = capturedParams.includeRawChunks === true;
      const result = snapshotMiddlewareResult(
        await Reflect.apply(doStream, model, [
          {
            ...capturedParams,
            includeRawChunks: true,
          },
        ]),
        "reasoning stream result"
      );
      const stream = result.stream;
      if (typeof stream !== "object" || stream === null) {
        throw new TypeError("reasoning stream result.stream must be an object");
      }
      consumeOwnDataPromiseFields(stream, ["pipeThrough"]);
      const pipeThrough = Reflect.get(stream, "pipeThrough");
      if (
        consumeGenuinePromise(pipeThrough) ||
        typeof pipeThrough !== "function"
      ) {
        throw new TypeError(
          "reasoning stream result.stream.pipeThrough must be a function"
        );
      }
      const reasoningDetails: JSONValue[] = [];
      const outputReasoningDetailsStore =
        createOpenGatewayReasoningDetailsStoreMemo(
          capturedReasoningDetailsStore
        );
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

      let transformedStream: unknown;
      try {
        const transform = new TransformStream<
          LanguageModelV4StreamPart,
          LanguageModelV4StreamPart
        >({
          async transform(part, controller) {
            const capturedPart = captureReasoningStreamPart(part);
            if (capturedPart.type === "raw") {
              appendUniqueJsonDetails(
                reasoningDetails,
                collectChoiceReasoningDetails(capturedPart.rawValue)
              );
              await enqueuePendingToolCall(controller);
              if (includeRawChunks) {
                controller.enqueue(capturedPart);
              }
              return;
            }

            if (capturedPart.type === "tool-call") {
              await enqueuePendingToolCall(controller);
              pendingToolCall = capturedPart;
              return;
            }

            await enqueuePendingToolCall(controller);

            if (isReasoningStreamPart(capturedPart)) {
              carriedReasoningDetailsCount = reasoningDetails.length;
              controller.enqueue(
                await withReasoningPartMetadata(
                  capturedPart,
                  reasoningDetails,
                  outputReasoningDetailsStore
                )
              );
              return;
            }

            if (isTextStreamPart(capturedPart)) {
              carriedReasoningDetailsCount = reasoningDetails.length;
              controller.enqueue(
                await withReasoningPartMetadata(
                  capturedPart,
                  reasoningDetails,
                  outputReasoningDetailsStore
                )
              );
              return;
            }

            controller.enqueue(capturedPart);
          },
          async flush(controller) {
            await enqueuePendingToolCall(controller);
          },
        });
        transformedStream = Reflect.apply(pipeThrough, stream, [transform]);
      } catch (error) {
        discardReasoningStream(stream);
        throw error;
      }
      if (
        consumeGenuinePromise(transformedStream) ||
        typeof transformedStream !== "object" ||
        transformedStream === null
      ) {
        discardReasoningStream(stream);
        throw new TypeError(
          "reasoning stream pipeThrough must return a synchronous stream"
        );
      }
      return {
        ...result,
        stream: transformedStream,
      } as Awaited<ReturnType<typeof doStream>>;
    },
  };
}
