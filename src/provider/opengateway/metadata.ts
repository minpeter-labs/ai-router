import type { MetadataExtractor } from "@ai-sdk/openai-compatible";
import {
  isJSONObject,
  isJSONValue,
  type JSONObject,
  type JSONValue,
  type SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { boundedEnumerableOwnKeys } from "../../core/http-headers";
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

const OPENGATEWAY_METADATA_KEY = "opengateway";
const MAX_METADATA_PROVIDERS = 128;
const MAX_METADATA_PROVIDER_NAME_LENGTH = 256;
const MAX_METADATA_BODY_CONTAINERS = 50_000;
const MAX_METADATA_BODY_CHARACTERS = 4_194_304;
const MAX_REASONING_CHOICES = 1024;
const MAX_REASONING_DETAILS = 1024;
const MAX_REASONING_DETAIL_CONTAINERS = 1000;
const MAX_REASONING_DETAIL_CHARACTERS = 65_536;
const MAX_REASONING_DETAILS_CONTAINERS = 10_000;
const MAX_REASONING_DETAILS_CHARACTERS = 1_048_576;
const OPTIONAL_METADATA_TIMEOUT_MS = 1000;
const reasoningDetailBudgets = new WeakMap<
  JSONValue[],
  { characters: number; containers: number; seen: Set<string> }
>();

export function canonicalJsonValueKey(value: JSONValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    const parts = new Array<string>(value.length);
    for (let index = 0; index < value.length; index += 1) {
      parts[index] = canonicalJsonValueKey(value[index] as JSONValue);
    }
    return `[${parts.join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = new Array<string>(keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    parts[index] =
      `${JSON.stringify(key)}:${canonicalJsonValueKey(value[key] as JSONValue)}`;
  }
  return `{${parts.join(",")}}`;
}

function reasoningDetailBudget(target: JSONValue[]): {
  characters: number;
  containers: number;
  seen: Set<string>;
} {
  const existing = reasoningDetailBudgets.get(target);
  if (existing !== undefined) {
    return existing;
  }
  const budget = { characters: 0, containers: 0, seen: new Set<string>() };
  const targetLength = target.length;
  const length =
    Number.isSafeInteger(targetLength) && targetLength >= 0
      ? Math.min(targetLength, MAX_REASONING_DETAILS)
      : 0;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(target, index)) {
      continue;
    }
    const snapshot = snapshotJsonValue(
      target[index],
      MAX_REASONING_DETAIL_CONTAINERS,
      MAX_REASONING_DETAIL_CHARACTERS
    );
    if (snapshot.valid && snapshot.value !== null) {
      budget.characters += snapshot.characters ?? 0;
      budget.containers += snapshot.containers ?? 0;
      budget.seen.add(canonicalJsonValueKey(snapshot.value as JSONValue));
    }
  }
  reasoningDetailBudgets.set(target, budget);
  return budget;
}

export function appendUniqueJsonDetails(
  target: JSONValue[],
  details: unknown
): void {
  const budget = reasoningDetailBudget(target);
  if (consumeGenuinePromise(details)) {
    return;
  }
  if (!Array.isArray(details)) {
    return;
  }
  let length = 0;
  try {
    const candidate = details.length;
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      return;
    }
    length = Math.min(candidate, MAX_REASONING_DETAILS);
  } catch {
    return;
  }
  consumeOwnDataPromiseFields(
    details,
    Array.from({ length }, (_, index) => index)
  );
  for (let index = 0; index < length; index += 1) {
    if (target.length >= MAX_REASONING_DETAILS) {
      return;
    }
    try {
      if (!Object.hasOwn(details, index)) {
        continue;
      }
      const snapshot = snapshotJsonValue(
        details[index],
        Math.min(
          MAX_REASONING_DETAIL_CONTAINERS,
          MAX_REASONING_DETAILS_CONTAINERS - budget.containers
        ),
        Math.min(
          MAX_REASONING_DETAIL_CHARACTERS,
          MAX_REASONING_DETAILS_CHARACTERS - budget.characters
        )
      );
      if (!snapshot.valid || snapshot.value === null) {
        continue;
      }
      const detail = snapshot.value as JSONValue;
      const key = canonicalJsonValueKey(detail);
      if (budget.seen.has(key)) {
        continue;
      }
      budget.seen.add(key);
      budget.characters += snapshot.characters ?? 0;
      budget.containers += snapshot.containers ?? 0;
      target.push(detail);
    } catch {
      // Ignore one hostile detail while preserving other bounded entries.
    }
  }
}

export function snapshotUniqueJsonDetails(details: unknown): JSONValue[] {
  const snapshot: JSONValue[] = [];
  appendUniqueJsonDetails(snapshot, details);
  return snapshot;
}

function appendReasoningDetailsValue(
  target: JSONValue[],
  value: unknown
): void {
  if (value === null || value === undefined) {
    return;
  }
  appendUniqueJsonDetails(target, Array.isArray(value) ? value : [value]);
}

function snapshotMetadataBody(value: unknown): JSONObject | undefined {
  const snapshot = snapshotJsonValue(
    value,
    MAX_METADATA_BODY_CONTAINERS,
    MAX_METADATA_BODY_CHARACTERS
  );
  return snapshot.valid && isJSONObject(snapshot.value)
    ? snapshot.value
    : undefined;
}

export function collectChoiceReasoningDetails(body: unknown): JSONValue[] {
  const stableBody = snapshotMetadataBody(body);
  if (stableBody === undefined) {
    return [];
  }

  const choices = stableBody.choices;
  if (!Array.isArray(choices)) {
    return [];
  }

  const details: JSONValue[] = [];
  const choiceLength = choices.length;
  if (!Number.isSafeInteger(choiceLength) || choiceLength < 0) {
    return details;
  }
  const length = Math.min(choiceLength, MAX_REASONING_CHOICES);
  for (let index = 0; index < length; index += 1) {
    try {
      if (!Object.hasOwn(choices, index)) {
        continue;
      }
      const choice = choices[index];
      if (!isJSONObject(choice)) {
        continue;
      }
      const message = choice.message;
      if (isJSONObject(message)) {
        appendReasoningDetailsValue(details, message.reasoning_details);
      }
      const delta = choice.delta;
      if (isJSONObject(delta)) {
        appendReasoningDetailsValue(details, delta.reasoning_details);
      }
    } catch {
      // Ignore one hostile choice while retaining other bounded choices.
    }
  }
  return details;
}

function extractRouting(body: unknown): JSONValue | undefined {
  const stableBody = snapshotMetadataBody(body);
  if (stableBody === undefined) {
    return;
  }

  const extra = stableBody.extra;
  if (isJSONObject(extra) && isJSONValue(extra.routing)) {
    return extra.routing;
  }

  return isJSONValue(stableBody.routing) ? stableBody.routing : undefined;
}

function buildOpenGatewayMetadata(
  routing: JSONValue | undefined
): SharedV4ProviderMetadata | undefined {
  const metadata: JSONObject = {};
  if (routing !== undefined) {
    metadata.routing = routing;
  }
  return Object.keys(metadata).length > 0
    ? { [OPENGATEWAY_METADATA_KEY]: metadata }
    : undefined;
}

function extractOpenGatewayMetadata(
  body: unknown
): SharedV4ProviderMetadata | undefined {
  return buildOpenGatewayMetadata(extractRouting(body));
}

function mergeProviderMetadata(
  first?: SharedV4ProviderMetadata,
  second?: SharedV4ProviderMetadata
): SharedV4ProviderMetadata | undefined {
  const left = sanitizeProviderMetadata(first);
  const right = sanitizeProviderMetadata(second);
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }

  const merged: SharedV4ProviderMetadata = {};
  for (const providerName of boundedEnumerableOwnKeys(
    left,
    MAX_METADATA_PROVIDERS
  ) ?? []) {
    defineMetadata(merged, providerName, left[providerName]);
  }
  for (const providerName of boundedEnumerableOwnKeys(
    right,
    MAX_METADATA_PROVIDERS
  ) ?? []) {
    defineMetadata(
      merged,
      providerName,
      mergeMetadataObjects(
        Object.hasOwn(merged, providerName) ? merged[providerName] : undefined,
        right[providerName]
      )
    );
  }
  return sanitizeProviderMetadata(merged);
}

function defineMetadata(
  target: SharedV4ProviderMetadata,
  providerName: string,
  metadata: JSONObject
): void {
  Object.defineProperty(target, providerName, {
    configurable: true,
    enumerable: true,
    value: metadata,
    writable: true,
  });
}

function mergeMetadataObjects(
  first: JSONObject | undefined,
  second: JSONObject
): JSONObject {
  const merged: JSONObject = {};
  for (const source of [first, second]) {
    if (source === undefined) {
      continue;
    }
    for (const key of boundedEnumerableOwnKeys(source, 1024) ?? []) {
      Object.defineProperty(merged, key, {
        configurable: true,
        enumerable: true,
        value: source[key],
        writable: true,
      });
    }
  }
  return merged;
}

function sanitizeProviderMetadata(
  value: unknown
): SharedV4ProviderMetadata | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const keys = boundedEnumerableOwnKeys(value, MAX_METADATA_PROVIDERS);
  if (
    keys === undefined ||
    keys.some(
      (key) =>
        key.length === 0 || key.length > MAX_METADATA_PROVIDER_NAME_LENGTH
    )
  ) {
    return;
  }
  const snapshot = snapshotJsonValue(value);
  if (
    !snapshot.valid ||
    typeof snapshot.value !== "object" ||
    snapshot.value === null ||
    Array.isArray(snapshot.value)
  ) {
    return;
  }
  const metadata = snapshot.value as Record<string, unknown>;
  for (const key of keys) {
    const item = metadata[key];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return;
    }
  }
  return metadata as SharedV4ProviderMetadata;
}

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
