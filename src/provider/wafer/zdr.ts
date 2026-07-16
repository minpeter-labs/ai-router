import { boundedEnumerableOwnKeys } from "../../core/http-headers";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  requireGenuinePromise,
} from "../../core/runtime-types";

export const ZDR_HEADER = "Wafer-ZDR";
const MAX_ZDR_HEADERS = 1024;
const REQUEST_INIT_KEYS = [
  "body",
  "cache",
  "credentials",
  "headers",
  "integrity",
  "keepalive",
  "method",
  "mode",
  "priority",
  "redirect",
  "referrer",
  "referrerPolicy",
  "signal",
  "window",
] as const;

export function createZdrFetch(
  fetch: typeof globalThis.fetch | undefined
): typeof globalThis.fetch {
  const baseFetch = fetch ?? ((input, init) => globalThis.fetch(input, init));
  return (input, init) => {
    if (consumeGenuinePromise(input)) {
      throw new TypeError("Wafer fetch input must be synchronous");
    }
    const capturedInit = snapshotRequestInit(init);
    if (preconsumeHeadersInit(capturedInit.headers)) {
      throw new TypeError("Wafer header values must be synchronous");
    }
    const requestHeaders = new Headers(capturedInit.headers);
    requestHeaders.set(ZDR_HEADER, "required");
    return requireGenuinePromise<Response>(
      baseFetch(input, { ...capturedInit, headers: requestHeaders }),
      (cause) =>
        new TypeError("Wafer fetch must return a genuine Promise", { cause })
    );
  };
}

function snapshotRequestInit(value: RequestInit | undefined): RequestInit {
  if (value === undefined) {
    return {};
  }
  if (consumeGenuinePromise(value)) {
    throw new TypeError("Wafer RequestInit must be synchronous");
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Wafer RequestInit must be an object");
  }
  consumeOwnDataPromiseFields(value, REQUEST_INIT_KEYS);
  const headersDescriptor = Object.getOwnPropertyDescriptor(value, "headers");
  let asyncHeaders = false;
  if (headersDescriptor !== undefined && "value" in headersDescriptor) {
    asyncHeaders = preconsumeHeadersInit(
      headersDescriptor.value as HeadersInit | undefined
    );
  }
  const snapshot: Record<string, unknown> = {};
  let asyncField = false;
  for (const key of REQUEST_INIT_KEYS) {
    const field = Reflect.get(value, key);
    if (consumeGenuinePromise(field)) {
      asyncField = true;
    }
    if (key === "headers" && !consumeGenuinePromise(field)) {
      asyncHeaders =
        preconsumeHeadersInit(field as HeadersInit | undefined) || asyncHeaders;
    }
    if (field !== undefined) {
      snapshot[key] = field;
    }
  }
  if (asyncField) {
    throw new TypeError("Wafer RequestInit fields must be synchronous");
  }
  if (asyncHeaders) {
    throw new TypeError("Wafer header values must be synchronous");
  }
  return snapshot as RequestInit;
}

function preconsumeHeadersInit(value: HeadersInit | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  if (consumeGenuinePromise(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return preconsumeTupleHeaders(value);
  }
  if (typeof value !== "object" || value === null || value instanceof Headers) {
    return false;
  }
  return preconsumeRecordHeaders(value);
}

function preconsumeTupleHeaders(value: unknown[]): boolean {
  const length = Reflect.get(value, "length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_ZDR_HEADERS
  ) {
    throw new TypeError(
      `Wafer headers must contain at most ${MAX_ZDR_HEADERS} entries`
    );
  }
  const indexes = Array.from({ length }, (_, index) => index);
  consumeOwnDataPromiseFields(value, indexes);
  let asyncHeader = false;
  for (const index of indexes) {
    const entry = Reflect.get(value, index);
    if (consumeGenuinePromise(entry)) {
      asyncHeader = true;
      continue;
    }
    if (Array.isArray(entry)) {
      consumeOwnDataPromiseFields(entry, [0, 1]);
      const name = Reflect.get(entry, 0);
      const item = Reflect.get(entry, 1);
      const asyncName = consumeGenuinePromise(name);
      const asyncItem = consumeGenuinePromise(item);
      if (asyncName || asyncItem) {
        asyncHeader = true;
      }
    }
  }
  return asyncHeader;
}

function preconsumeRecordHeaders(value: object): boolean {
  const keys = boundedEnumerableOwnKeys(value, MAX_ZDR_HEADERS);
  if (keys === undefined) {
    throw new TypeError(
      `Wafer headers must contain at most ${MAX_ZDR_HEADERS} entries`
    );
  }
  consumeOwnDataPromiseFields(value, keys);
  let asyncHeader = false;
  for (const key of keys) {
    if (consumeGenuinePromise(Reflect.get(value, key))) {
      asyncHeader = true;
    }
  }
  return asyncHeader;
}
