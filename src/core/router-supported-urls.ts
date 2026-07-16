import { boundedEnumerableOwnKeys } from "./http-headers";
import { consumeOwnDataPromiseFields } from "./runtime-types";
import { clearTimerSafely, scheduleTimer } from "./timeout";

export const MAX_SUPPORTED_URL_MEDIA_TYPES = 128;
export const MAX_SUPPORTED_URL_PATTERNS = 128;
export const MAX_SUPPORTED_URL_TOTAL_PATTERNS = 1024;
export const MAX_SUPPORTED_URL_PATTERN_CHARS = 1_048_576;
export const MAX_SUPPORTED_URL_PATTERN_LENGTH = 4096;
export const SUPPORTED_URLS_DISCOVERY_TIMEOUT_MS = 1000;

export function cloneSupportedUrlPattern(value: unknown): RegExp | undefined {
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
      source.length > MAX_SUPPORTED_URL_PATTERN_LENGTH
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

export function cloneSupportedUrlPatterns(
  value: unknown
): { chars: number; patterns: RegExp[] } | undefined {
  if (!Array.isArray(value)) {
    return;
  }
  const length = Reflect.get(value, "length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_SUPPORTED_URL_PATTERNS
  ) {
    return;
  }
  consumeOwnDataPromiseFields(
    value,
    Array.from({ length }, (_, index) => index)
  );
  const patterns = new Array<RegExp>(length);
  let chars = 0;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return;
    }
    const pattern = cloneSupportedUrlPattern(Reflect.get(value, index));
    if (pattern === undefined) {
      return;
    }
    chars += pattern.source.length;
    patterns[index] = pattern;
  }
  return { chars, patterns };
}

export function consumeSupportedUrlPromiseFields(
  value: object,
  keys: readonly string[]
): void {
  consumeOwnDataPromiseFields(value, keys);
  for (const key of keys) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        continue;
      }
      const patterns = descriptor.value;
      if (!Array.isArray(patterns)) {
        continue;
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(
        patterns,
        "length"
      );
      const length =
        lengthDescriptor !== undefined && "value" in lengthDescriptor
          ? lengthDescriptor.value
          : undefined;
      if (
        typeof length === "number" &&
        Number.isSafeInteger(length) &&
        length >= 0 &&
        length <= MAX_SUPPORTED_URL_PATTERNS
      ) {
        consumeOwnDataPromiseFields(
          patterns,
          Array.from({ length }, (_, index) => index)
        );
      }
    } catch {
      // Malformed Proxy containers cannot prevent later bounded cleanup.
    }
  }
}

export function sanitizeSupportedUrls(
  value: unknown
): Record<string, RegExp[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  try {
    const keys = boundedEnumerableOwnKeys(value, MAX_SUPPORTED_URL_MEDIA_TYPES);
    if (keys === undefined) {
      return {};
    }
    consumeSupportedUrlPromiseFields(value, keys);
    const result: Record<string, RegExp[]> = {};
    let totalPatterns = 0;
    let totalPatternChars = 0;
    for (const key of keys) {
      if (key === "then" || key.length === 0 || key.length > 256) {
        return {};
      }
      const cloned = cloneSupportedUrlPatterns(Reflect.get(value, key));
      if (cloned === undefined) {
        return {};
      }
      totalPatterns += cloned.patterns.length;
      totalPatternChars += cloned.chars;
      if (totalPatterns > MAX_SUPPORTED_URL_TOTAL_PATTERNS) {
        return {};
      }
      if (totalPatternChars > MAX_SUPPORTED_URL_PATTERN_CHARS) {
        return {};
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloned.patterns,
        writable: true,
      });
    }
    return result;
  } catch {
    return {};
  }
}

export function settleSupportedUrls(
  supported: Promise<unknown>
): Promise<Record<string, RegExp[]>> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: Record<string, RegExp[]>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimerSafely(timeout);
      resolve(value);
    };
    try {
      timeout = scheduleTimer(
        () => finish({}),
        SUPPORTED_URLS_DISCOVERY_TIMEOUT_MS
      );
    } catch {
      finish({});
      return;
    }
    try {
      const chained = Promise.prototype.then.call(
        supported,
        (value: unknown) => finish(sanitizeSupportedUrls(value)),
        () => finish({})
      );
      try {
        Promise.prototype.then.call(
          chained,
          () => undefined,
          () => undefined
        );
      } catch {
        // A custom PromiseLike may return a non-Promise value.
      }
    } catch {
      finish({});
    }
  });
}
