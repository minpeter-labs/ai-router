import type { LanguageModelV4StreamResult } from "@ai-sdk/provider";
import {
  boundedEnumerableOwnKeys,
  hasInvalidHttpHeaderValueCharacter,
  isValidHttpHeaderName,
} from "./http-headers";
import { snapshotJsonValue } from "./json-value";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";

export const MAX_STREAM_RESULT_HEADERS = 1024;
export const MAX_STREAM_RESULT_HEADER_LENGTH = 65_536;
export const MAX_STREAM_RESULT_HEADER_CHARS = 1_048_576;

export function safeStreamRequest(
  result: LanguageModelV4StreamResult
): LanguageModelV4StreamResult["request"] {
  try {
    const request = result.request;
    if (request === undefined) {
      return;
    }
    if (consumeGenuinePromise(request)) {
      return;
    }
    if (
      typeof request !== "object" ||
      request === null ||
      Array.isArray(request)
    ) {
      return;
    }
    const body = Reflect.get(request, "body");
    if (body === undefined) {
      return {};
    }
    if (consumeGenuinePromise(body)) {
      return {};
    }
    const snapshot = snapshotJsonValue(body);
    return snapshot.valid ? { body: snapshot.value } : {};
  } catch {
    return;
  }
}

export function safeStreamResponse(
  result: LanguageModelV4StreamResult
): LanguageModelV4StreamResult["response"] {
  try {
    const response = result.response;
    if (response === undefined) {
      return;
    }
    if (consumeGenuinePromise(response)) {
      return;
    }
    if (
      typeof response !== "object" ||
      response === null ||
      Array.isArray(response)
    ) {
      return;
    }
    const headers = Reflect.get(response, "headers");
    if (headers === undefined) {
      return {};
    }
    if (consumeGenuinePromise(headers)) {
      return {};
    }
    if (
      typeof headers !== "object" ||
      headers === null ||
      Array.isArray(headers)
    ) {
      return;
    }
    const keys = boundedEnumerableOwnKeys(headers, MAX_STREAM_RESULT_HEADERS);
    if (keys === undefined) {
      return;
    }
    consumeOwnDataPromiseFields(headers, keys);
    if (keys.some((key) => !isValidHttpHeaderName(key))) {
      return;
    }
    const sanitized: Record<string, string> = {};
    let totalChars = 0;
    let asyncFailure = false;
    for (const key of keys) {
      const value = Reflect.get(headers, key);
      if (consumeGenuinePromise(value)) {
        asyncFailure = true;
        continue;
      }
      if (
        typeof value !== "string" ||
        value.length > MAX_STREAM_RESULT_HEADER_LENGTH ||
        hasInvalidHttpHeaderValueCharacter(value)
      ) {
        return;
      }
      totalChars += key.length + value.length;
      if (totalChars > MAX_STREAM_RESULT_HEADER_CHARS) {
        return;
      }
      Object.defineProperty(sanitized, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
    if (asyncFailure) {
      return;
    }
    return { headers: sanitized };
  } catch {
    return;
  }
}

export interface StreamMetadataSnapshot {
  request: LanguageModelV4StreamResult["request"];
  response: LanguageModelV4StreamResult["response"];
}

export function snapshotStreamResultMetadata(
  result: LanguageModelV4StreamResult
): StreamMetadataSnapshot {
  return {
    request: safeStreamRequest(result),
    response: safeStreamResponse(result),
  };
}

export function copyStreamRequest(
  request: LanguageModelV4StreamResult["request"]
): LanguageModelV4StreamResult["request"] {
  if (request === undefined) {
    return;
  }
  if (request.body === undefined) {
    return {};
  }
  const snapshot = snapshotJsonValue(request.body);
  return snapshot.valid ? { body: snapshot.value } : {};
}

export function copyStreamResponse(
  response: LanguageModelV4StreamResult["response"]
): LanguageModelV4StreamResult["response"] {
  if (response === undefined) {
    return;
  }
  if (response.headers === undefined) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const key of Object.keys(response.headers)) {
    Object.defineProperty(headers, key, {
      configurable: true,
      enumerable: true,
      value: response.headers[key],
      writable: true,
    });
  }
  return { headers };
}
