import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { NormalizedEntry } from "./router-entry";
import { VALID_MODALITIES } from "./router-options";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  isPlainObjectValue,
} from "./runtime-types";
import type { Modality } from "./types";

export const STABLE_MODELS = new WeakSet<object>();

/** Snapshot callable model operations once while preserving their original `this`. */
export function snapshotLanguageModelV4(
  value: unknown
): LanguageModelV4 | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (STABLE_MODELS.has(value)) {
    return value as LanguageModelV4;
  }
  if (consumeGenuinePromise(value)) {
    return;
  }
  consumeOwnDataPromiseFields(value, [
    "doGenerate",
    "doStream",
    "modelId",
    "provider",
    "specificationVersion",
  ]);
  // Accessor throws are intentionally allowed to escape: unlike a stable
  // non-v4 shape, a factory/model getter failure can be transient and must not
  // be memoized in the permanent invalid-model cache.
  const specificationVersion = Reflect.get(value, "specificationVersion");
  if (
    consumeGenuinePromise(specificationVersion) ||
    specificationVersion !== "v4"
  ) {
    return;
  }
  const doGenerate = Reflect.get(value, "doGenerate");
  const doStream = Reflect.get(value, "doStream");
  const modelId = Reflect.get(value, "modelId", value);
  const provider = Reflect.get(value, "provider", value);
  let asyncRequiredSlot = false;
  for (const slot of [doGenerate, doStream, modelId, provider]) {
    if (consumeGenuinePromise(slot)) {
      asyncRequiredSlot = true;
    }
  }
  if (
    asyncRequiredSlot ||
    typeof doGenerate !== "function" ||
    typeof doStream !== "function" ||
    (modelId !== undefined && typeof modelId !== "string") ||
    (provider !== undefined && typeof provider !== "string")
  ) {
    return;
  }
  let supportedUrls: LanguageModelV4["supportedUrls"];
  let supportedUrlsRead = false;
  const model: LanguageModelV4 = {
    doGenerate: (options) => Reflect.apply(doGenerate, value, [options]),
    doStream: (options) => Reflect.apply(doStream, value, [options]),
    modelId: modelId as string,
    provider: provider as string,
    specificationVersion: "v4",
    get supportedUrls() {
      if (!supportedUrlsRead) {
        supportedUrlsRead = true;
        try {
          supportedUrls = Reflect.get(value, "supportedUrls", value);
        } catch {
          supportedUrls = {};
        }
      }
      return supportedUrls;
    },
  };
  STABLE_MODELS.add(model);
  return model;
}

export function snapshotAdaptiveConcurrency(
  value: unknown
): NormalizedEntry["adaptiveConcurrency"] {
  if (consumeGenuinePromise(value)) {
    throw new Error("ai-router: adaptiveConcurrency must be synchronous");
  }
  if (!isPlainObjectValue(value)) {
    return value as NormalizedEntry["adaptiveConcurrency"];
  }
  const config = value as import("./types").AdaptiveConcurrencyConfig;
  const keys = ["increaseAfterSuccesses", "initial", "max", "min"] as const;
  consumeOwnDataPromiseFields(config, keys);
  const snapshot = {
    increaseAfterSuccesses: config.increaseAfterSuccesses,
    initial: config.initial,
    max: config.max,
    min: config.min,
  };
  let asyncField = false;
  for (const field of Object.values(snapshot)) {
    if (consumeGenuinePromise(field)) {
      asyncField = true;
    }
  }
  if (asyncField) {
    throw new Error("ai-router: adaptiveConcurrency must be synchronous");
  }
  return snapshot;
}

export function snapshotSupports(value: unknown): Modality[] | undefined {
  if (value === undefined) {
    return;
  }
  if (consumeGenuinePromise(value)) {
    throw new Error("ai-router: supports must be synchronous");
  }
  if (!Array.isArray(value)) {
    throw new Error("ai-router: supports contains an unknown modality");
  }
  let length: number;
  try {
    length = Reflect.get(value, "length");
  } catch {
    throw new Error("ai-router: supports contains an unknown modality");
  }
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > VALID_MODALITIES.size
  ) {
    throw new Error("ai-router: supports contains an unknown modality");
  }
  consumeOwnDataPromiseFields(
    value,
    Array.from({ length }, (_, index) => index)
  );
  const snapshot: Modality[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error("ai-router: supports contains an unknown modality");
    }
    let modality: unknown;
    try {
      modality = Reflect.get(value, index);
    } catch {
      throw new Error("ai-router: supports contains an unknown modality");
    }
    if (!VALID_MODALITIES.has(modality as Modality)) {
      throw new Error("ai-router: supports contains an unknown modality");
    }
    snapshot.push(modality as Modality);
  }
  return snapshot;
}
