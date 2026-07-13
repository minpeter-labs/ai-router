import type { JSONValue, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";
import { boundedEnumerableOwnKeys } from "../../core/http-headers";
import { snapshotReasoningRequestBody } from "../../core/reasoning";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "../../core/runtime-types";
import {
  appendUniqueJsonDetails,
  collectChoiceReasoningDetails,
} from "./metadata";
import { withReasoningDetailsOnPrompt } from "./reasoning-roundtrip-input";
import {
  captureReasoningStreamPart,
  withReasoningDetailsOnContent,
  withReasoningPartMetadata,
} from "./reasoning-roundtrip-output";
import {
  captureOpenGatewayReasoningDetailsStore,
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

const MIDDLEWARE_HOOK_KEYS = [
  "doGenerate",
  "doStream",
  "model",
  "params",
  "type",
] as const;
const MAX_MIDDLEWARE_RESULT_FIELDS = 128;

function snapshotMiddlewareResult(
  value: unknown,
  name: string
): Record<string, unknown> {
  if (consumeGenuinePromise(value)) {
    throw new TypeError(`${name} must be synchronous`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = boundedEnumerableOwnKeys(value, MAX_MIDDLEWARE_RESULT_FIELDS);
  if (keys === undefined) {
    throw new TypeError(
      `${name} must contain at most ${MAX_MIDDLEWARE_RESULT_FIELDS} fields`
    );
  }
  consumeOwnDataPromiseFields(value, keys);
  const snapshot: Record<string, unknown> = {};
  let asyncField = false;
  for (const key of keys) {
    const field = Reflect.get(value, key);
    if (consumeGenuinePromise(field)) {
      asyncField = true;
    }
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: field,
      writable: true,
    });
  }
  if (asyncField) {
    throw new TypeError(`${name} fields must be synchronous`);
  }
  return snapshot;
}

function discardReasoningStream(stream: object): void {
  try {
    const cancel = Reflect.get(stream, "cancel");
    if (consumeGenuinePromise(cancel) || typeof cancel !== "function") {
      return;
    }
    consumeGenuinePromise(
      Reflect.apply(cancel, stream, ["reasoning stream setup failed"])
    );
  } catch {
    // Transform setup failure remains primary over best-effort cancellation.
  }
}

function captureMiddlewareHookArgs(value: unknown): Record<string, unknown> {
  if (consumeGenuinePromise(value)) {
    throw new TypeError(
      "reasoning middleware hook arguments must be synchronous"
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError(
      "reasoning middleware hook arguments must be an object"
    );
  }
  consumeOwnDataPromiseFields(value, MIDDLEWARE_HOOK_KEYS);
  const captured: Record<string, unknown> = {};
  let asyncField = false;
  for (const key of MIDDLEWARE_HOOK_KEYS) {
    const field = Reflect.get(value, key);
    if (consumeGenuinePromise(field)) {
      asyncField = true;
    }
    captured[key] = field;
  }
  if (typeof captured.model === "object" && captured.model !== null) {
    consumeOwnDataPromiseFields(captured.model, [
      "doGenerate",
      "doStream",
      "modelId",
      "provider",
      "specificationVersion",
      "supportedUrls",
    ]);
  }
  if (asyncField) {
    throw new TypeError("reasoning middleware hook fields must be synchronous");
  }
  return captured;
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
