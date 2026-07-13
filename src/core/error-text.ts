const DEFAULT_MAX_CHARS = 16_384;
const MAX_DEPTH = 5;
const MAX_NODES = 256;
const MAX_PROPERTIES_PER_OBJECT = 64;
const MAX_PARSED_ERROR_JSON_CHARS = 65_536;
const JSON_CONTAINER_PREFIX_RE = /^[\s\r\n]*[[{]/;
const PROVIDER_ERROR_KEYS = new Set([
  "error",
  "errors",
  "code",
  "type",
  "tag",
  "message",
  "title",
  "detail",
  "details",
  "reason",
  "description",
]);
const PROVIDER_ERROR_WRAPPER_KEYS = new Set(["body", "data", "response"]);
const PROVIDER_SEMANTIC_KEYS = [
  ...PROVIDER_ERROR_KEYS,
  ...PROVIDER_ERROR_WRAPPER_KEYS,
] as const;
const GENERAL_ERROR_KEYS = [
  "name",
  "message",
  "statusCode",
  "status",
  "code",
  "type",
  "tag",
  "error",
  "errors",
  "title",
  "detail",
  "details",
  "reason",
  "description",
  "body",
  "data",
  "response",
  "cause",
] as const;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd8_00 && code <= 0xdb_ff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc_00 && code <= 0xdf_ff;
}

function safePrefix(value: string, maximum: number): string {
  let end = Math.min(value.length, Math.max(0, maximum));
  if (
    end > 0 &&
    end < value.length &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

function safeSuffix(value: string, maximum: number): string {
  let start = Math.max(0, value.length - Math.max(0, maximum));
  if (
    start > 0 &&
    start < value.length &&
    isHighSurrogate(value.charCodeAt(start - 1)) &&
    isLowSurrogate(value.charCodeAt(start))
  ) {
    start += 1;
  }
  return value.slice(start);
}

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function parseProviderErrorJSON(value: string): unknown | undefined {
  if (
    value.length > MAX_PARSED_ERROR_JSON_CHARS ||
    !JSON_CONTAINER_PREFIX_RE.test(value)
  ) {
    return;
  }
  try {
    return JSON.parse(value);
  } catch {
    return;
  }
}

class BoundedTextCollector {
  private chars = 0;
  private nodes = 0;
  private parsedErrorJsonChars = 0;
  private readonly maxChars: number;
  private readonly parts: string[] = [];
  private readonly seen = new WeakSet<object>();
  private readonly semanticFieldsOnly: boolean;

  constructor(maxChars: number, semanticFieldsOnly = false) {
    this.maxChars = Number.isFinite(maxChars)
      ? Math.max(0, Math.floor(maxChars))
      : DEFAULT_MAX_CHARS;
    this.semanticFieldsOnly = semanticFieldsOnly;
  }

  collect(value: unknown): string {
    this.visit(value, 0);
    return safePrefix(this.parts.join(" "), this.maxChars);
  }

  private append(text: string): void {
    if (this.chars >= this.maxChars) {
      return;
    }
    const remaining = this.maxChars - this.chars;
    const split = Math.floor(remaining * 0.75);
    const bounded =
      text.length <= remaining || remaining < 16
        ? safePrefix(text, remaining)
        : `${safePrefix(text, split - 3)} … ${safeSuffix(
            text,
            remaining - split
          )}`;
    this.parts.push(bounded);
    this.chars += bounded.length + 1;
  }

  private appendPrimitive(value: unknown): boolean {
    if (typeof value === "string") {
      this.append(value);
      return true;
    }
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      this.append(String(value));
      return true;
    }
    return false;
  }

  private visit(value: unknown, depth: number): void {
    if (consumeGenuinePromise(value)) {
      return;
    }
    if (this.atLimit(depth) || this.appendPrimitive(value)) {
      return;
    }
    if (!isObjectLike(value) || this.seen.has(value)) {
      return;
    }
    consumeOwnDataPromiseFields(
      value,
      this.semanticFieldsOnly ? PROVIDER_SEMANTIC_KEYS : GENERAL_ERROR_KEYS
    );
    this.seen.add(value);
    this.nodes += 1;
    this.visitProperties(value as Record<string, unknown>, depth);
  }

  private atLimit(depth: number): boolean {
    return (
      this.chars >= this.maxChars ||
      this.nodes >= MAX_NODES ||
      depth > MAX_DEPTH
    );
  }

  private visitProperties(value: Record<string, unknown>, depth: number): void {
    if (this.semanticFieldsOnly) {
      this.visitSemanticProperties(value, depth);
      return;
    }
    for (const key of GENERAL_ERROR_KEYS) {
      if (this.chars >= this.maxChars) {
        break;
      }
      try {
        if (!Object.hasOwn(value, key)) {
          continue;
        }
        this.append(key);
        this.visitOwnDataProperty(value, key, depth);
      } catch {
        // Ignore hostile descriptor traps while retaining other known fields.
      }
    }
  }

  private visitOwnDataProperty(
    value: Record<string, unknown>,
    key: string,
    depth: number
  ): void {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) {
        this.visit(descriptor.value, depth + 1);
      }
    } catch {
      // Ignore hostile descriptor traps while retaining other known fields.
    }
  }

  private visitSemanticProperties(
    value: Record<string, unknown>,
    depth: number
  ): void {
    let array = false;
    try {
      array = Array.isArray(value);
    } catch {
      return;
    }
    if (array) {
      this.visitSemanticArray(value as unknown as unknown[], depth);
      return;
    }
    for (const key of PROVIDER_ERROR_KEYS) {
      this.visitSemanticKey(value, key, depth, false);
    }
    for (const key of PROVIDER_ERROR_WRAPPER_KEYS) {
      this.visitSemanticKey(value, key, depth, true);
    }
  }

  private visitSemanticArray(value: unknown[], depth: number): void {
    let length = 0;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, "length");
      const candidate =
        descriptor !== undefined && "value" in descriptor
          ? descriptor.value
          : undefined;
      if (!Number.isSafeInteger(candidate) || candidate < 0) {
        return;
      }
      length = Math.min(candidate, MAX_PROPERTIES_PER_OBJECT);
    } catch {
      return;
    }
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          continue;
        }
        this.append(key);
        this.visit(descriptor.value, depth + 1);
      } catch {
        // Ignore hostile indexes while retaining other bounded entries.
      }
    }
  }

  private visitSemanticKey(
    value: Record<string, unknown>,
    key: string,
    depth: number,
    wrapper: boolean
  ): void {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return;
      }
      let nested = descriptor.value;
      if (wrapper && typeof nested === "string") {
        nested = this.parseNestedProviderErrorJSON(nested);
      }
      if (wrapper && !isObjectLike(nested)) {
        return;
      }
      this.append(key);
      this.visit(nested, depth + 1);
    } catch {
      // Ignore hostile descriptor traps while retaining other fields.
    }
  }

  private parseNestedProviderErrorJSON(value: string): unknown | undefined {
    if (
      value.length >
      MAX_PARSED_ERROR_JSON_CHARS - this.parsedErrorJsonChars
    ) {
      return;
    }
    this.parsedErrorJsonChars += value.length;
    return parseProviderErrorJSON(value);
  }
}

/** Extract bounded classifier text without serializing an entire provider body. */
export function boundedErrorText(
  value: unknown,
  maxChars = DEFAULT_MAX_CHARS
): string {
  return new BoundedTextCollector(maxChars).collect(value);
}

/** Extract only provider error-semantic fields, excluding echoed request data. */
export function boundedProviderErrorText(
  value: unknown,
  maxChars = DEFAULT_MAX_CHARS
): string {
  let source = value;
  if (typeof value === "string") {
    if (!JSON_CONTAINER_PREFIX_RE.test(value)) {
      return boundedErrorText(value, maxChars);
    }
    source = parseProviderErrorJSON(value);
    if (source === undefined) {
      return "";
    }
  }
  return new BoundedTextCollector(maxChars, true).collect(source);
}

export function safeErrorProperty(value: unknown, key: string): unknown {
  if (!isObjectLike(value)) {
    return;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return;
  }
}

import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";
