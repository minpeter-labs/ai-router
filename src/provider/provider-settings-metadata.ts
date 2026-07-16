import type { MetadataExtractor } from "@ai-sdk/openai-compatible";
import { isJSONObject, type SharedV4ProviderMetadata } from "@ai-sdk/provider";
import { snapshotJsonValue } from "../core/json-value";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  requireGenuinePromise,
} from "../core/runtime-types";

export const OPENAI_COMPATIBLE_SETTING_KEYS = [
  "apiKey",
  "baseURL",
  "convertUsage",
  "fetch",
  "headers",
  "includeUsage",
  "metadataExtractor",
  "queryParams",
  "supportedUrls",
  "supportsStructuredOutputs",
] as const;
export const MAX_PROVIDER_MODEL_ID_LENGTH = 4096;
export const MAX_PROVIDER_STRING_RECORD_ENTRIES = 1024;
export const MAX_PROVIDER_STRING_RECORD_VALUE_LENGTH = 65_536;
export const MAX_PROVIDER_STRING_RECORD_CHARACTERS = 1_048_576;
export const MAX_PROVIDER_SUPPORTED_MEDIA_TYPES = 128;
export const MAX_PROVIDER_SUPPORTED_PATTERNS_PER_TYPE = 128;
export const MAX_PROVIDER_SUPPORTED_PATTERNS = 1024;
export const MAX_PROVIDER_SUPPORTED_PATTERN_LENGTH = 4096;
export const MAX_PROVIDER_SUPPORTED_PATTERN_CHARACTERS = 1_048_576;
export const INPUT_USAGE_KEYS = [
  "cacheRead",
  "cacheWrite",
  "noCache",
  "total",
] as const;
export const OUTPUT_USAGE_KEYS = ["reasoning", "text", "total"] as const;

export function captureProviderModelId(
  value: unknown,
  provider: string
): string {
  if (
    consumeGenuinePromise(value) ||
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PROVIDER_MODEL_ID_LENGTH
  ) {
    throw new TypeError(
      `${provider} modelId must be a synchronous non-empty string of at most ${MAX_PROVIDER_MODEL_ID_LENGTH} characters`
    );
  }
  return value;
}

export function captureProviderMetadataExtractor(
  value: MetadataExtractor | undefined,
  provider: string
): MetadataExtractor | undefined {
  if (value === undefined) {
    return;
  }
  consumeOwnDataPromiseFields(value, [
    "createStreamExtractor",
    "extractMetadata",
  ]);
  const createStreamExtractor = Reflect.get(value, "createStreamExtractor");
  const extractMetadata = Reflect.get(value, "extractMetadata");
  const asyncCreate = consumeGenuinePromise(createStreamExtractor);
  const asyncExtract = consumeGenuinePromise(extractMetadata);
  if (
    asyncCreate ||
    asyncExtract ||
    typeof createStreamExtractor !== "function" ||
    typeof extractMetadata !== "function"
  ) {
    throw new TypeError(
      `${provider} metadataExtractor methods must be synchronous functions`
    );
  }
  return {
    async extractMetadata(args) {
      try {
        const parsedBody = snapshotProviderCallbackJson(args.parsedBody);
        if (parsedBody === undefined) {
          return;
        }
        const result = Reflect.apply(extractMetadata, value, [{ parsedBody }]);
        const promise = requireGenuinePromise<
          SharedV4ProviderMetadata | undefined
        >(
          result,
          (cause) =>
            new TypeError(
              `${provider} metadataExtractor.extractMetadata must return a genuine Promise`,
              { cause }
            )
        );
        return sanitizeCapturedMetadata(await promise);
      } catch {
        return;
      }
    },
    createStreamExtractor() {
      let source: unknown;
      try {
        source = Reflect.apply(createStreamExtractor, value, []);
      } catch {
        return emptyStreamMetadataExtractor();
      }
      if (consumeGenuinePromise(source)) {
        return emptyStreamMetadataExtractor();
      }
      if (typeof source !== "object" || source === null) {
        return emptyStreamMetadataExtractor();
      }
      consumeOwnDataPromiseFields(source, ["buildMetadata", "processChunk"]);
      const buildMetadata = Reflect.get(source, "buildMetadata");
      const processChunk = Reflect.get(source, "processChunk");
      const asyncBuild = consumeGenuinePromise(buildMetadata);
      const asyncProcess = consumeGenuinePromise(processChunk);
      if (
        asyncBuild ||
        asyncProcess ||
        typeof buildMetadata !== "function" ||
        typeof processChunk !== "function"
      ) {
        return emptyStreamMetadataExtractor();
      }
      return {
        processChunk(parsedChunk) {
          try {
            const capturedChunk = snapshotProviderCallbackJson(parsedChunk);
            if (capturedChunk === undefined) {
              return;
            }
            consumeGenuinePromise(
              Reflect.apply(processChunk, source, [capturedChunk])
            );
          } catch {
            // Optional metadata cannot fail a successful provider stream.
          }
        },
        buildMetadata() {
          try {
            const result = Reflect.apply(buildMetadata, source, []);
            return consumeGenuinePromise(result)
              ? undefined
              : sanitizeCapturedMetadata(result);
          } catch {
            return;
          }
        },
      };
    },
  };
}

export function emptyStreamMetadataExtractor(): ReturnType<
  MetadataExtractor["createStreamExtractor"]
> {
  return {
    buildMetadata: () => undefined,
    processChunk: () => undefined,
  };
}

export function sanitizeCapturedMetadata(
  value: unknown
): SharedV4ProviderMetadata | undefined {
  if (value === undefined) {
    return;
  }
  const snapshot = snapshotJsonValue(value, 10_000, 4_194_304);
  return snapshot.valid && isJSONObject(snapshot.value)
    ? (snapshot.value as SharedV4ProviderMetadata)
    : undefined;
}

export function snapshotProviderCallbackJson(
  value: unknown
): unknown | undefined {
  const snapshot = snapshotJsonValue(value, 10_000, 4_194_304);
  return snapshot.valid ? snapshot.value : undefined;
}
