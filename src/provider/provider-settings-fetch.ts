import type { OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible";
import { isJSONObject, type LanguageModelV4Usage } from "@ai-sdk/provider";
import { snapshotJsonValue } from "../core/json-value";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  requireGenuinePromise,
} from "../core/runtime-types";

import {
  INPUT_USAGE_KEYS,
  OUTPUT_USAGE_KEYS,
  snapshotProviderCallbackJson,
} from "./provider-settings-metadata";

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

export function snapshotProviderUsage(
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

export function consumeUsageFieldPromises(
  value: unknown,
  keys: readonly string[]
): void {
  if (typeof value === "object" && value !== null) {
    consumeOwnDataPromiseFields(value, keys);
  }
}

export function snapshotTokenContainer(
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
