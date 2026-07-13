import { boundedEnumerableOwnKeys } from "./http-headers";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_OBJECT_KEYS = 1024;
const MAX_JSON_ARRAY_ITEMS = 10_000;
const MAX_JSON_CHARACTERS = 4_194_304;

export interface JsonSnapshot {
  async?: boolean;
  characters?: number;
  containers?: number;
  valid: boolean;
  value?: unknown;
}

interface JsonContext {
  active: WeakSet<object>;
  characters: number;
  maximum: number;
  maximumCharacters: number;
  nodes: number;
}

class AsyncJsonValueError extends Error {}

function isJsonObjectContainer(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function visitJsonArray(
  value: unknown[],
  depth: number,
  context: JsonContext
): unknown[] {
  const length = Reflect.get(value, "length");
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_JSON_ARRAY_ITEMS
  ) {
    throw new Error("sparse or oversized JSON array");
  }
  consumeOwnDataPromiseFields(
    value,
    Array.from({ length }, (_, index) => index)
  );
  const snapshot = new Array<unknown>(length);
  let asyncFailure: AsyncJsonValueError | undefined;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error("sparse or oversized JSON array");
    }
    try {
      snapshot[index] = visitJson(
        Reflect.get(value, index),
        depth + 1,
        context
      );
    } catch (error) {
      if (!(error instanceof AsyncJsonValueError)) {
        throw error;
      }
      asyncFailure ??= error;
    }
  }
  if (asyncFailure !== undefined) {
    throw asyncFailure;
  }
  return snapshot;
}

function visitJsonObject(
  value: object,
  depth: number,
  context: JsonContext
): Record<string, unknown> {
  if (!isJsonObjectContainer(value)) {
    throw new Error("JSON objects must use an ordinary object prototype");
  }
  const keys = boundedEnumerableOwnKeys(value, MAX_JSON_OBJECT_KEYS);
  if (keys === undefined) {
    throw new Error("oversized JSON object");
  }
  consumeOwnDataPromiseFields(value, keys);
  const snapshot: Record<string, unknown> = {};
  let asyncFailure: AsyncJsonValueError | undefined;
  for (const key of keys) {
    context.characters += key.length;
    if (context.characters > context.maximumCharacters) {
      throw new Error("oversized JSON object keys");
    }
    try {
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: visitJson(Reflect.get(value, key), depth + 1, context),
        writable: true,
      });
    } catch (error) {
      if (!(error instanceof AsyncJsonValueError)) {
        throw error;
      }
      asyncFailure ??= error;
    }
  }
  if (asyncFailure !== undefined) {
    throw asyncFailure;
  }
  return snapshot;
}

function visitJson(
  value: unknown,
  depth: number,
  context: JsonContext
): unknown {
  if (consumeGenuinePromise(value)) {
    throw new AsyncJsonValueError("Promises are not JSON values");
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    context.characters += value.length;
    if (context.characters > context.maximumCharacters) {
      throw new Error("oversized JSON string content");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-finite JSON number");
    }
    return value;
  }
  if (typeof value !== "object" || depth > MAX_JSON_DEPTH) {
    throw new Error("invalid or excessively deep JSON value");
  }
  context.nodes += 1;
  if (context.nodes > context.maximum || context.active.has(value)) {
    throw new Error("cyclic or oversized JSON value");
  }
  context.active.add(value);
  try {
    if (Array.isArray(value)) {
      return visitJsonArray(value, depth, context);
    }
    return visitJsonObject(value, depth, context);
  } finally {
    context.active.delete(value);
  }
}

/** Validate and copy a JSON value without invoking any property more than once. */
export function snapshotJsonValue(
  value: unknown,
  maximumContainers = MAX_JSON_NODES,
  maximumCharacters = MAX_JSON_CHARACTERS
): JsonSnapshot {
  try {
    const maximum =
      Number.isSafeInteger(maximumContainers) && maximumContainers >= 0
        ? Math.min(MAX_JSON_NODES, maximumContainers)
        : 0;
    const characters =
      Number.isSafeInteger(maximumCharacters) && maximumCharacters >= 0
        ? Math.min(MAX_JSON_CHARACTERS, maximumCharacters)
        : 0;
    const context = {
      active: new WeakSet<object>(),
      characters: 0,
      maximum,
      maximumCharacters: characters,
      nodes: 0,
    };
    const snapshot = visitJson(value, 0, context);
    return {
      characters: context.characters,
      containers: context.nodes,
      valid: true,
      value: snapshot,
    };
  } catch (error) {
    if (error instanceof AsyncJsonValueError) {
      return { async: true, valid: false };
    }
    return { valid: false };
  }
}

/** Count JSON object/array containers without walking past a caller's cap. */
function pushContainerChildren(current: object, stack: object[]): boolean {
  if (Array.isArray(current)) {
    const length = Reflect.get(current, "length");
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_JSON_ARRAY_ITEMS
    ) {
      return false;
    }
    consumeOwnDataPromiseFields(
      current,
      Array.from({ length }, (_, index) => index)
    );
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(current, index)) {
        return false;
      }
      const child = Reflect.get(current, index);
      if (typeof child === "object" && child !== null) {
        stack.push(child);
      }
    }
    return true;
  }
  const keys = boundedEnumerableOwnKeys(current, MAX_JSON_OBJECT_KEYS);
  if (keys === undefined) {
    return false;
  }
  consumeOwnDataPromiseFields(current, keys);
  for (const key of keys) {
    const child = Reflect.get(current, key);
    if (typeof child === "object" && child !== null) {
      stack.push(child);
    }
  }
  return true;
}

export function countJsonContainersUpTo(
  value: unknown,
  maximum: number
): number {
  if (typeof value !== "object" || value === null) {
    return 0;
  }
  const overflow =
    Number.isSafeInteger(maximum) && maximum >= 0 ? maximum + 1 : 1;
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    return overflow;
  }
  const stack: object[] = [value];
  let count = 0;
  try {
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) {
        break;
      }
      count += 1;
      if (count > maximum) {
        return count;
      }
      if (!pushContainerChildren(current, stack)) {
        return overflow;
      }
    }
  } catch {
    return overflow;
  }
  return count;
}
