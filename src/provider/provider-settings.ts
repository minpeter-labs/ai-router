import {
  boundedEnumerableOwnKeys,
  hasInvalidHttpHeaderValueCharacter,
  isValidHttpHeaderName,
} from "../core/http-headers";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "../core/runtime-types";

import {
  MAX_PROVIDER_STRING_RECORD_CHARACTERS,
  MAX_PROVIDER_STRING_RECORD_ENTRIES,
  MAX_PROVIDER_STRING_RECORD_VALUE_LENGTH,
  OPENAI_COMPATIBLE_SETTING_KEYS,
} from "./provider-settings-metadata";
import { snapshotProviderStringRecord } from "./provider-settings-records";

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
