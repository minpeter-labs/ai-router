import { boundedEnumerableOwnKeys } from "../core/http-headers";
import {
  captureGenuinePromise,
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  requireGenuinePromise,
} from "../core/runtime-types";

import {
  MAX_PROVIDER_SUPPORTED_MEDIA_TYPES,
  MAX_PROVIDER_SUPPORTED_PATTERN_CHARACTERS,
  MAX_PROVIDER_SUPPORTED_PATTERN_LENGTH,
  MAX_PROVIDER_SUPPORTED_PATTERNS,
  MAX_PROVIDER_SUPPORTED_PATTERNS_PER_TYPE,
} from "./provider-settings-metadata";

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

export function snapshotProviderSupportedUrlsResult(
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

export function cloneSupportedPatterns(
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

export function preconsumePatternEntries(value: unknown): void {
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

export function cloneSupportedPattern(value: unknown): RegExp | undefined {
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
