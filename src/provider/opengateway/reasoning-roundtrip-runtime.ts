import type { JSONValue, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { boundedEnumerableOwnKeys } from "../../core/http-headers";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "../../core/runtime-types";

export function isReasoningStreamPart(
  part: LanguageModelV4StreamPart
): boolean {
  return (
    part.type === "reasoning-delta" ||
    part.type === "reasoning-end" ||
    part.type === "reasoning-start"
  );
}

export function isTextStreamPart(part: LanguageModelV4StreamPart): boolean {
  return (
    part.type === "text-delta" ||
    part.type === "text-end" ||
    part.type === "text-start"
  );
}

export function detailsSince(
  details: readonly JSONValue[],
  count: number
): readonly JSONValue[] {
  return details.slice(count);
}

const MIDDLEWARE_HOOK_KEYS = [
  "doGenerate",
  "doStream",
  "model",
  "params",
  "type",
] as const;
const MAX_MIDDLEWARE_RESULT_FIELDS = 128;

export function snapshotMiddlewareResult(
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

export function discardReasoningStream(stream: object): void {
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

export function captureMiddlewareHookArgs(
  value: unknown
): Record<string, unknown> {
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
