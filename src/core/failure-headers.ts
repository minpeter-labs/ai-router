import { safeErrorProperty } from "./error-text";
import { consumeGenuinePromise } from "./runtime-types";

const RATE_LIMIT_HEADER_NAMES = new Set([
  "retry-after-ms",
  "retry-after",
  "x-ratelimit-reset",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "ratelimit-reset",
]);
const RATE_LIMIT_HEADER_ALIASES = new Map<string, readonly string[]>([
  ["retry-after-ms", ["Retry-After-Ms", "Retry-After-MS", "RETRY-AFTER-MS"]],
  ["retry-after", ["Retry-After", "RETRY-AFTER"]],
  [
    "x-ratelimit-reset",
    ["X-RateLimit-Reset", "X-Ratelimit-Reset", "X-RATELIMIT-RESET"],
  ],
  [
    "x-ratelimit-reset-requests",
    [
      "X-RateLimit-Reset-Requests",
      "X-Ratelimit-Reset-Requests",
      "X-RATELIMIT-RESET-REQUESTS",
    ],
  ],
  [
    "x-ratelimit-reset-tokens",
    [
      "X-RateLimit-Reset-Tokens",
      "X-Ratelimit-Reset-Tokens",
      "X-RATELIMIT-RESET-TOKENS",
    ],
  ],
  [
    "ratelimit-reset",
    ["RateLimit-Reset", "Ratelimit-Reset", "RATELIMIT-RESET"],
  ],
]);

export interface HeaderSource {
  get?: CallableFunction;
  value: unknown;
  values?: ReadonlyMap<string, readonly string[]>;
}

const MAX_HEADER_VALUES = 16;
const MAX_HEADER_VALUE_CHARS = 512;

function headerStrings(value: unknown): string[] {
  if (consumeGenuinePromise(value)) {
    return [];
  }
  if (typeof value === "string") {
    return [value.slice(0, MAX_HEADER_VALUE_CHARS)];
  }
  try {
    if (!Array.isArray(value)) {
      return [];
    }
  } catch {
    return [];
  }
  let length = 0;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    const candidate =
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      return [];
    }
    length = Math.min(candidate, MAX_HEADER_VALUES);
  } catch {
    return [];
  }
  const values: string[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !("value" in descriptor)) {
        continue;
      }
      const item = descriptor.value;
      if (consumeGenuinePromise(item)) {
        continue;
      }
      if (typeof item === "string") {
        values.push(item.slice(0, MAX_HEADER_VALUE_CHARS));
      }
    } catch {
      // Ignore hostile indexes while retaining other bounded values.
    }
  }
  return values;
}

export function headerSources(
  error: unknown,
  response: unknown,
  seen: Set<unknown>
): HeaderSource[] {
  const values = [
    safeErrorProperty(error, "responseHeaders"),
    safeErrorProperty(error, "headers"),
    safeErrorProperty(response, "responseHeaders"),
    safeErrorProperty(response, "headers"),
  ];
  const sources: HeaderSource[] = [];
  for (const value of values) {
    if (consumeGenuinePromise(value)) {
      continue;
    }
    if (
      ((typeof value === "object" && value !== null) ||
        typeof value === "function") &&
      seen.has(value)
    ) {
      continue;
    }
    seen.add(value);
    const getValue = safeErrorProperty(value, "get");
    const get = consumeGenuinePromise(getValue) ? undefined : getValue;
    const values = snapshotPlainHeaders(value);
    sources.push(
      typeof get === "function" ? { get, value, values } : { value, values }
    );
  }
  return sources;
}

function snapshotPlainHeaders(
  value: unknown
): ReadonlyMap<string, readonly string[]> {
  const snapshot = new Map<string, readonly string[]>();
  if (typeof value !== "object" || value === null) {
    return snapshot;
  }
  for (const name of RATE_LIMIT_HEADER_NAMES) {
    const header = ownHeaderValue(value, name);
    const values = headerStrings(header);
    if (values.length > 0) {
      snapshot.set(name, values);
    }
  }
  snapshotCaseInsensitiveHeaders(value, snapshot);
  return snapshot;
}

function snapshotCaseInsensitiveHeaders(
  value: object,
  snapshot: Map<string, readonly string[]>
): void {
  for (const [normalized, aliases] of RATE_LIMIT_HEADER_ALIASES) {
    if (snapshot.has(normalized)) {
      continue;
    }
    for (const alias of aliases) {
      const values = headerStrings(ownHeaderValue(value, alias));
      if (values.length > 0) {
        snapshot.set(normalized, values);
        break;
      }
    }
  }
}

function ownHeaderValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return;
  }
}

export function headerValues(
  sources: readonly HeaderSource[],
  name: string
): string[] {
  const values: string[] = [];
  for (const source of sources) {
    values.push(...headerValuesFrom(source, name));
  }
  return values;
}

function headerValuesFromGetter(source: HeaderSource, name: string): string[] {
  if (source.get === undefined) {
    return [];
  }
  try {
    const value = Reflect.apply(source.get, source.value, [name]);
    if (consumeGenuinePromise(value)) {
      return [];
    }
    return headerStrings(value);
  } catch {
    return [];
  }
}

function headerValuesFrom(
  source: HeaderSource,
  name: string
): readonly string[] {
  const getterValues = headerValuesFromGetter(source, name);
  if (getterValues.length > 0) {
    return getterValues;
  }
  return source.values?.get(name) ?? [];
}
