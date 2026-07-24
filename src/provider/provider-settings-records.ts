import { boundedEnumerableOwnKeys } from "../core/http-headers";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "../core/runtime-types";

import {
  MAX_PROVIDER_STRING_RECORD_CHARACTERS,
  MAX_PROVIDER_STRING_RECORD_ENTRIES,
  MAX_PROVIDER_STRING_RECORD_VALUE_LENGTH,
} from "./provider-settings-metadata";

export function snapshotProviderStringRecord(
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
