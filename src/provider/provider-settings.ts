import type {
  MetadataExtractor,
  OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import {
  isJSONObject,
  type LanguageModelV4Usage,
  type SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import {
  boundedEnumerableOwnKeys,
  hasInvalidHttpHeaderValueCharacter,
  isValidHttpHeaderName,
} from "../core/http-headers";
import { snapshotJsonValue } from "../core/json-value";
import {
  captureGenuinePromise,
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
const MAX_PROVIDER_MODEL_ID_LENGTH = 4096;
const MAX_PROVIDER_STRING_RECORD_ENTRIES = 1024;
const MAX_PROVIDER_STRING_RECORD_VALUE_LENGTH = 65_536;
const MAX_PROVIDER_STRING_RECORD_CHARACTERS = 1_048_576;
const MAX_PROVIDER_SUPPORTED_MEDIA_TYPES = 128;
const MAX_PROVIDER_SUPPORTED_PATTERNS_PER_TYPE = 128;
const MAX_PROVIDER_SUPPORTED_PATTERNS = 1024;
const MAX_PROVIDER_SUPPORTED_PATTERN_LENGTH = 4096;
const MAX_PROVIDER_SUPPORTED_PATTERN_CHARACTERS = 1_048_576;
const INPUT_USAGE_KEYS = [
  "cacheRead",
  "cacheWrite",
  "noCache",
  "total",
] as const;
const OUTPUT_USAGE_KEYS = ["reasoning", "text", "total"] as const;

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

function emptyStreamMetadataExtractor(): ReturnType<
  MetadataExtractor["createStreamExtractor"]
> {
  return {
    buildMetadata: () => undefined,
    processChunk: () => undefined,
  };
}

function sanitizeCapturedMetadata(
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

export function captureProviderConvertUsage(
  value: OpenAICompatibleProviderSettings["convertUsage"],
  provider: string,
  receiver: object
): OpenAICompatibleProviderSettings["convertUsage"] {
  if (value === undefined) {
    return;
  }
  return (usage) => {
    const capturedUsage = snapshotProviderCallbackJson(usage);
    if (capturedUsage === undefined) {
      throw new TypeError(
        `${provider} convertUsage input must be bounded JSON`
      );
    }
    const result = Reflect.apply(value, receiver, [capturedUsage]);
    if (consumeGenuinePromise(result)) {
      throw new TypeError(`${provider} convertUsage must return synchronously`);
    }
    return snapshotProviderUsage(result, provider);
  };
}

function snapshotProviderCallbackJson(value: unknown): unknown | undefined {
  const snapshot = snapshotJsonValue(value, 10_000, 4_194_304);
  return snapshot.valid ? snapshot.value : undefined;
}

export function captureProviderFetch(
  value: typeof globalThis.fetch | undefined,
  provider: string,
  receiver: object
): typeof globalThis.fetch | undefined {
  if (value === undefined) {
    return;
  }
  return (input, init) => {
    let result: unknown;
    try {
      result = Reflect.apply(value, receiver, [input, init]);
    } catch (cause) {
      return Promise.reject(cause);
    }
    const promise = requireGenuinePromise<Response>(
      result,
      (cause) =>
        new TypeError(`${provider} fetch must return a genuine Promise`, {
          cause,
        })
    );
    return promise.then((response) => {
      if (typeof response !== "object" || response === null) {
        throw new TypeError(
          `${provider} fetch must resolve to a response object`
        );
      }
      return response;
    });
  };
}

function snapshotProviderUsage(
  value: unknown,
  provider: string
): LanguageModelV4Usage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${provider} convertUsage must return an object`);
  }
  consumeOwnDataPromiseFields(value, ["inputTokens", "outputTokens", "raw"]);
  for (const [key, fields] of [
    ["inputTokens", INPUT_USAGE_KEYS],
    ["outputTokens", OUTPUT_USAGE_KEYS],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      consumeUsageFieldPromises(descriptor.value, fields);
    }
  }
  const inputTokens = Reflect.get(value, "inputTokens");
  const outputTokens = Reflect.get(value, "outputTokens");
  const raw = Reflect.get(value, "raw");
  const asyncInput = consumeGenuinePromise(inputTokens);
  const asyncOutput = consumeGenuinePromise(outputTokens);
  const asyncRaw = consumeGenuinePromise(raw);
  if (asyncInput || asyncOutput || asyncRaw) {
    throw new TypeError(`${provider} convertUsage fields must be synchronous`);
  }
  const inputSnapshot = snapshotTokenContainer(
    inputTokens,
    INPUT_USAGE_KEYS,
    provider,
    "inputTokens"
  );
  const outputSnapshot = snapshotTokenContainer(
    outputTokens,
    OUTPUT_USAGE_KEYS,
    provider,
    "outputTokens"
  );
  let rawSnapshot: LanguageModelV4Usage["raw"];
  if (raw !== undefined) {
    const snapshot = snapshotJsonValue(raw, 10_000, 1_048_576);
    if (!(snapshot.valid && isJSONObject(snapshot.value))) {
      throw new TypeError(`${provider} convertUsage raw must be bounded JSON`);
    }
    rawSnapshot = snapshot.value;
  }
  return {
    inputTokens: inputSnapshot as LanguageModelV4Usage["inputTokens"],
    outputTokens: outputSnapshot as LanguageModelV4Usage["outputTokens"],
    raw: rawSnapshot,
  };
}

function consumeUsageFieldPromises(
  value: unknown,
  keys: readonly string[]
): void {
  if (typeof value === "object" && value !== null) {
    consumeOwnDataPromiseFields(value, keys);
  }
}

function snapshotTokenContainer(
  value: unknown,
  keys: readonly string[],
  provider: string,
  name: string
): Record<string, number | undefined> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${provider} convertUsage ${name} must be an object`);
  }
  consumeOwnDataPromiseFields(value, keys);
  const snapshot: Record<string, number | undefined> = {};
  let asyncField = false;
  for (const key of keys) {
    const item = Reflect.get(value, key);
    if (consumeGenuinePromise(item)) {
      asyncField = true;
      continue;
    }
    if (
      item !== undefined &&
      (typeof item !== "number" || !Number.isFinite(item) || item < 0)
    ) {
      throw new TypeError(
        `${provider} convertUsage ${name}.${key} must be a non-negative finite number`
      );
    }
    snapshot[key] = item as number | undefined;
  }
  if (asyncField) {
    throw new TypeError(
      `${provider} convertUsage ${name} fields must be synchronous`
    );
  }
  return snapshot;
}

export function prepareProviderSettings(
  settings: unknown,
  provider: string,
  additionalKeys: readonly string[] = []
): asserts settings is object {
  if (consumeGenuinePromise(settings)) {
    throw new TypeError(`${provider} settings must be synchronous`);
  }
  if (typeof settings !== "object" || settings === null) {
    throw new TypeError(`${provider} settings must be an object`);
  }
  consumeOwnDataPromiseFields(settings, [
    ...OPENAI_COMPATIBLE_SETTING_KEYS,
    ...additionalKeys,
  ]);
}

export function rejectAsyncProviderSettingValues(
  values: readonly unknown[],
  provider: string
): void {
  let asyncSetting = false;
  for (const value of values) {
    if (consumeGenuinePromise(value)) {
      asyncSetting = true;
    }
  }
  if (asyncSetting) {
    throw new TypeError(`${provider} settings must be synchronous`);
  }
}

export function validateCommonProviderSettings(
  settings: Record<string, unknown>,
  provider: string
): void {
  for (const key of ["apiKey", "baseURL"] as const) {
    const value = settings[key];
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length === 0 || value.length > 8192)
    ) {
      throw new TypeError(
        `${provider} ${key} must be a non-empty bounded string`
      );
    }
  }
  for (const key of ["includeUsage", "supportsStructuredOutputs"] as const) {
    const value = settings[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypeError(`${provider} ${key} must be a boolean`);
    }
  }
  for (const key of ["convertUsage", "fetch"] as const) {
    const value = settings[key];
    if (value !== undefined && typeof value !== "function") {
      throw new TypeError(`${provider} ${key} must be a function`);
    }
  }
  const metadataExtractor = settings.metadataExtractor;
  if (
    metadataExtractor !== undefined &&
    (typeof metadataExtractor !== "object" ||
      metadataExtractor === null ||
      Array.isArray(metadataExtractor))
  ) {
    throw new TypeError(`${provider} metadataExtractor must be an object`);
  }
  const supportedUrls = settings.supportedUrls;
  if (supportedUrls !== undefined && typeof supportedUrls !== "function") {
    throw new TypeError(`${provider} supportedUrls must be a function`);
  }
}

export function snapshotProviderHeaders(
  value: Record<string, string> | undefined,
  provider: string
): Record<string, string> | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${provider} headers must be an object`);
  }
  const keys = boundedEnumerableOwnKeys(
    value,
    MAX_PROVIDER_STRING_RECORD_ENTRIES
  );
  if (keys === undefined) {
    throw new TypeError(
      `${provider} headers must contain at most ${MAX_PROVIDER_STRING_RECORD_ENTRIES} entries`
    );
  }
  consumeOwnDataPromiseFields(value, keys);
  if (keys.some((key) => !isValidHttpHeaderName(key))) {
    throw new TypeError(`${provider} header names must use valid HTTP syntax`);
  }
  const entries: Array<readonly [string, unknown]> = [];
  let asyncValue = false;
  for (const key of keys) {
    const item = Reflect.get(value, key);
    if (consumeGenuinePromise(item)) {
      asyncValue = true;
    }
    entries.push([key, item]);
  }
  if (asyncValue) {
    throw new TypeError(`${provider} header values must be synchronous`);
  }
  const snapshot: Record<string, string> = {};
  let totalCharacters = 0;
  for (const [key, item] of entries) {
    if (
      typeof item !== "string" ||
      item.length > MAX_PROVIDER_STRING_RECORD_VALUE_LENGTH ||
      hasInvalidHttpHeaderValueCharacter(item)
    ) {
      throw new TypeError(
        `${provider} header values must use valid HTTP syntax`
      );
    }
    totalCharacters += key.length + item.length;
    if (totalCharacters > MAX_PROVIDER_STRING_RECORD_CHARACTERS) {
      throw new TypeError(
        `${provider} headers exceed ${MAX_PROVIDER_STRING_RECORD_CHARACTERS} aggregate characters`
      );
    }
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return snapshot;
}

export function snapshotProviderQueryParams(
  value: Record<string, string> | undefined,
  provider: string
): Record<string, string> | undefined {
  return snapshotProviderStringRecord(
    value,
    provider,
    "query parameters",
    "query parameter"
  );
}

export function captureProviderSupportedUrls(
  value:
    | (() => PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>)
    | undefined,
  provider: string,
  receiver: object
):
  | (() => PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>)
  | undefined {
  if (value === undefined) {
    return;
  }
  return () => {
    const result = Reflect.apply(value, receiver, []);
    const promise = captureGenuinePromise<Record<string, RegExp[]>>(result);
    if (promise !== undefined) {
      return promise.then((resolved) =>
        snapshotProviderSupportedUrlsResult(resolved, provider)
      );
    }
    if (typeof result !== "object" || result === null) {
      return requireGenuinePromise<Record<string, RegExp[]>>(
        result,
        (cause) =>
          new TypeError(
            `${provider} supportedUrls must return synchronously or as a genuine Promise`,
            { cause }
          )
      );
    }
    return snapshotProviderSupportedUrlsResult(result, provider);
  };
}

function snapshotProviderSupportedUrlsResult(
  value: unknown,
  provider: string
): Record<string, RegExp[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${provider} supportedUrls must be an object`);
  }
  const mediaTypes = boundedEnumerableOwnKeys(
    value,
    MAX_PROVIDER_SUPPORTED_MEDIA_TYPES
  );
  if (mediaTypes === undefined) {
    throw new TypeError(
      `${provider} supportedUrls must contain at most ${MAX_PROVIDER_SUPPORTED_MEDIA_TYPES} media types`
    );
  }
  consumeOwnDataPromiseFields(value, mediaTypes);
  for (const mediaType of mediaTypes) {
    const descriptor = Object.getOwnPropertyDescriptor(value, mediaType);
    if (descriptor !== undefined && "value" in descriptor) {
      preconsumePatternEntries(descriptor.value);
    }
  }
  const captured: Array<readonly [string, unknown]> = [];
  let asyncField = false;
  for (const mediaType of mediaTypes) {
    const patterns = Reflect.get(value, mediaType);
    if (consumeGenuinePromise(patterns)) {
      asyncField = true;
    } else {
      preconsumePatternEntries(patterns);
    }
    captured.push([mediaType, patterns]);
  }
  if (asyncField) {
    throw new TypeError(`${provider} supportedUrls must be synchronous`);
  }
  const snapshot: Record<string, RegExp[]> = {};
  let totalPatterns = 0;
  let totalCharacters = 0;
  for (const [mediaType, patterns] of captured) {
    const cloned = cloneSupportedPatterns(patterns, provider);
    totalPatterns += cloned.patterns.length;
    if (totalPatterns > MAX_PROVIDER_SUPPORTED_PATTERNS) {
      throw new TypeError(
        `${provider} supportedUrls must contain at most ${MAX_PROVIDER_SUPPORTED_PATTERNS} patterns`
      );
    }
    totalCharacters += cloned.characters;
    if (totalCharacters > MAX_PROVIDER_SUPPORTED_PATTERN_CHARACTERS) {
      throw new TypeError(
        `${provider} supportedUrls exceed the aggregate pattern size limit`
      );
    }
    Object.defineProperty(snapshot, mediaType, {
      configurable: true,
      enumerable: true,
      value: cloned.patterns,
      writable: true,
    });
  }
  return snapshot;
}

function cloneSupportedPatterns(
  value: unknown,
  provider: string
): { characters: number; patterns: RegExp[] } {
  if (!Array.isArray(value)) {
    throw new TypeError(`${provider} supportedUrls values must be arrays`);
  }
  const length = Reflect.get(value, "length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_PROVIDER_SUPPORTED_PATTERNS_PER_TYPE
  ) {
    throw new TypeError(
      `${provider} supportedUrls pattern arrays must contain at most ${MAX_PROVIDER_SUPPORTED_PATTERNS_PER_TYPE} entries`
    );
  }
  const patterns = new Array<RegExp>(length);
  let asyncPattern = false;
  let characters = 0;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${provider} supportedUrls arrays must be dense`);
    }
    const pattern = Reflect.get(value, index);
    if (consumeGenuinePromise(pattern)) {
      asyncPattern = true;
      continue;
    }
    const copy = cloneSupportedPattern(pattern);
    if (copy === undefined) {
      throw new TypeError(`${provider} supportedUrls entries must be RegExp`);
    }
    characters += copy.source.length;
    patterns[index] = copy;
  }
  if (asyncPattern) {
    throw new TypeError(
      `${provider} supportedUrls entries must be synchronous`
    );
  }
  return { characters, patterns };
}

function preconsumePatternEntries(value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  const length = Reflect.get(value, "length");
  if (
    typeof length === "number" &&
    Number.isSafeInteger(length) &&
    length >= 0 &&
    length <= MAX_PROVIDER_SUPPORTED_PATTERNS_PER_TYPE
  ) {
    consumeOwnDataPromiseFields(
      value,
      Array.from({ length }, (_, index) => index)
    );
  }
}

function cloneSupportedPattern(value: unknown): RegExp | undefined {
  try {
    const sourceGetter = Object.getOwnPropertyDescriptor(
      RegExp.prototype,
      "source"
    )?.get;
    if (sourceGetter === undefined) {
      return;
    }
    const source = Reflect.apply(sourceGetter, value, []);
    if (
      typeof source !== "string" ||
      source.length > MAX_PROVIDER_SUPPORTED_PATTERN_LENGTH
    ) {
      return;
    }
    let flags = "";
    for (const [property, flag] of [
      ["hasIndices", "d"],
      ["global", "g"],
      ["ignoreCase", "i"],
      ["multiline", "m"],
      ["dotAll", "s"],
      ["unicode", "u"],
      ["unicodeSets", "v"],
      ["sticky", "y"],
    ] as const) {
      const getter = Object.getOwnPropertyDescriptor(
        RegExp.prototype,
        property
      )?.get;
      if (getter !== undefined && Reflect.apply(getter, value, []) === true) {
        flags += flag;
      }
    }
    return new RegExp(source, flags);
  } catch {
    return;
  }
}

function snapshotProviderStringRecord(
  value: Record<string, string> | undefined,
  provider: string,
  containerName: string,
  valueName: string
): Record<string, string> | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${provider} ${containerName} must be an object`);
  }
  const keys = boundedEnumerableOwnKeys(
    value,
    MAX_PROVIDER_STRING_RECORD_ENTRIES
  );
  if (keys === undefined) {
    throw new TypeError(
      `${provider} ${containerName} must contain at most ${MAX_PROVIDER_STRING_RECORD_ENTRIES} entries`
    );
  }
  consumeOwnDataPromiseFields(value, keys);
  const entries: Array<readonly [string, unknown]> = [];
  let asyncValue = false;
  for (const key of keys) {
    const item = Reflect.get(value, key);
    if (consumeGenuinePromise(item)) {
      asyncValue = true;
    }
    entries.push([key, item]);
  }
  if (asyncValue) {
    throw new TypeError(`${provider} ${valueName} values must be synchronous`);
  }
  const snapshot: Record<string, string> = {};
  let totalCharacters = 0;
  for (const [key, item] of entries) {
    if (typeof item !== "string") {
      throw new TypeError(`${provider} ${valueName} values must be strings`);
    }
    if (item.length > MAX_PROVIDER_STRING_RECORD_VALUE_LENGTH) {
      throw new TypeError(
        `${provider} ${valueName} values must contain at most ${MAX_PROVIDER_STRING_RECORD_VALUE_LENGTH} characters`
      );
    }
    totalCharacters += key.length + item.length;
    if (totalCharacters > MAX_PROVIDER_STRING_RECORD_CHARACTERS) {
      throw new TypeError(
        `${provider} ${containerName} exceed ${MAX_PROVIDER_STRING_RECORD_CHARACTERS} aggregate characters`
      );
    }
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return snapshot;
}
