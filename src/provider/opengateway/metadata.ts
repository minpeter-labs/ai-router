import type { MetadataExtractor } from "@ai-sdk/openai-compatible";
import type { JSONValue, SharedV4ProviderMetadata } from "@ai-sdk/provider";
import { snapshotJsonValue } from "../../core/json-value";
import {
  captureGenuinePromise,
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "../../core/runtime-types";
import { clearTimerSafely, scheduleTimer } from "../../core/timeout";
import {
  captureCallbackJsonMutationTargets,
  consumeCallbackJsonMutationPromises,
  consumeCallbackMutationsNowAndAfterPromise,
} from "./callback-json-mutations";

import {
  buildOpenGatewayMetadata,
  extractOpenGatewayMetadata,
  extractRouting,
  mergeProviderMetadata,
} from "./metadata-merge";

const OPTIONAL_METADATA_TIMEOUT_MS = 1000;

async function settleOptionalMetadata(
  promise: Promise<SharedV4ProviderMetadata | undefined>
): Promise<SharedV4ProviderMetadata | undefined> {
  return await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: SharedV4ProviderMetadata | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimerSafely(timer);
      resolve(value);
    };
    try {
      timer = scheduleTimer(
        () => finish(undefined),
        OPTIONAL_METADATA_TIMEOUT_MS
      );
    } catch {
      consumeGenuinePromise(promise);
      finish(undefined);
      return;
    }
    promise.then(finish, () => finish(undefined));
  });
}

export function createOpenGatewayMetadataExtractor(
  userExtractor?: MetadataExtractor
): MetadataExtractor {
  const capturedUserExtractor = optionalMethodSource(userExtractor, [
    "createStreamExtractor",
    "extractMetadata",
  ]) as MetadataExtractor | undefined;
  const extractMetadata = safeMethod(capturedUserExtractor, "extractMetadata");
  const createStreamExtractor = safeMethod(
    capturedUserExtractor,
    "createStreamExtractor"
  );
  return {
    async extractMetadata({ parsedBody }) {
      const opengatewayMetadata = extractOpenGatewayMetadata(parsedBody);
      let userMetadata: SharedV4ProviderMetadata | undefined;
      if (
        extractMetadata !== undefined &&
        capturedUserExtractor !== undefined
      ) {
        try {
          const capturedBody = snapshotOptionalMetadataInput(parsedBody);
          if (capturedBody === undefined) {
            return opengatewayMetadata;
          }
          const mutationTargets =
            captureCallbackJsonMutationTargets(capturedBody);
          try {
            const value = Reflect.apply(
              extractMetadata,
              capturedUserExtractor,
              [{ parsedBody: capturedBody }]
            );
            const promise = captureGenuinePromise<
              SharedV4ProviderMetadata | undefined
            >(value);
            userMetadata =
              promise === undefined
                ? (value as SharedV4ProviderMetadata | undefined)
                : await settleOptionalMetadata(promise);
          } finally {
            consumeCallbackJsonMutationPromises(mutationTargets);
          }
        } catch {
          // Optional metadata must not turn a successful provider response into
          // a routing failure.
        }
      }
      return mergeProviderMetadata(opengatewayMetadata, userMetadata);
    },
    createStreamExtractor() {
      let userStreamExtractor:
        | ReturnType<MetadataExtractor["createStreamExtractor"]>
        | undefined;
      if (
        createStreamExtractor !== undefined &&
        capturedUserExtractor !== undefined
      ) {
        try {
          userStreamExtractor = Reflect.apply(
            createStreamExtractor,
            capturedUserExtractor,
            []
          );
        } catch {
          // Continue with OpenGateway's built-in stream metadata only.
        }
      }
      userStreamExtractor = optionalMethodSource(userStreamExtractor, [
        "buildMetadata",
        "processChunk",
      ]) as typeof userStreamExtractor;
      const processChunk = safeMethod(userStreamExtractor, "processChunk");
      const buildMetadata = safeMethod(userStreamExtractor, "buildMetadata");
      let routing: JSONValue | undefined;

      return {
        processChunk(parsedChunk) {
          if (processChunk !== undefined && userStreamExtractor !== undefined) {
            try {
              const capturedChunk = snapshotOptionalMetadataInput(parsedChunk);
              if (capturedChunk !== undefined) {
                const mutationTargets =
                  captureCallbackJsonMutationTargets(capturedChunk);
                const value = Reflect.apply(processChunk, userStreamExtractor, [
                  capturedChunk,
                ]);
                consumeCallbackMutationsNowAndAfterPromise(
                  value,
                  mutationTargets
                );
              }
            } catch {
              // Optional user stream metadata is isolated per chunk.
            }
          }
          const chunkRouting = extractRouting(parsedChunk);
          if (chunkRouting !== undefined) {
            routing = chunkRouting;
          }
        },
        buildMetadata() {
          const opengatewayMetadata = buildOpenGatewayMetadata(routing);
          let userMetadata: SharedV4ProviderMetadata | undefined;
          if (
            buildMetadata !== undefined &&
            userStreamExtractor !== undefined
          ) {
            try {
              const value = Reflect.apply(
                buildMetadata,
                userStreamExtractor,
                []
              );
              if (!consumeGenuinePromise(value)) {
                userMetadata = value as SharedV4ProviderMetadata | undefined;
              }
            } catch {
              // Preserve built-in metadata when an optional hook fails.
            }
          }
          return mergeProviderMetadata(opengatewayMetadata, userMetadata);
        },
      };
    },
  };
}

function snapshotOptionalMetadataInput(value: unknown): unknown | undefined {
  const snapshot = snapshotJsonValue(value, 10_000, 4_194_304);
  return snapshot.valid ? snapshot.value : undefined;
}

function safeMethod<T extends object, K extends keyof T>(
  value: T | undefined,
  key: K
): CallableFunction | undefined {
  if (value === undefined) {
    return;
  }
  try {
    const method = Reflect.get(value, key);
    if (consumeGenuinePromise(method)) {
      return;
    }
    return typeof method === "function" ? method : undefined;
  } catch {
    return;
  }
}

function optionalMethodSource(
  value: unknown,
  keys: readonly string[]
): object | undefined {
  if (value === undefined || consumeGenuinePromise(value)) {
    return;
  }
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return;
  }
  consumeOwnDataPromiseFields(value, keys);
  return value;
}
