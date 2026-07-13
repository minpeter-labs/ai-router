import { describe, expect, it } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import { wrapStreamResult } from "../stream";
import { callOptions, drive, resolved, textModel } from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("copies special response-header keys without prototype mutation", async () => {
    const model = textModel(["ok"]);
    const candidates = [resolved(model)];
    const firstResult = await model.doStream(callOptions);
    const headers = Object.create(null) as Record<string, string>;
    Object.defineProperty(headers, "__proto__", {
      enumerable: true,
      value: "literal-header",
    });
    firstResult.response = { headers };
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    const copied = wrapped.response?.headers as Record<string, string>;
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.hasOwn(copied, "__proto__")).toBe(true);
    expect(Reflect.get(copied, "__proto__")).toBe("literal-header");
  });

  it("snapshots live stream metadata once and copies public containers", async () => {
    const reads = new Map<string, number>();
    const getter = (name: string, value: unknown) => ({
      enumerable: true,
      get() {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return value;
      },
    });
    const body = new FormData();
    body.set("opaque", "true");
    const headers = Object.defineProperty(
      {},
      "x-provider",
      getter("header", "stable")
    );
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    Object.defineProperties(firstResult, {
      request: getter(
        "request",
        Object.defineProperty({}, "body", getter("body", body))
      ),
      response: getter(
        "response",
        Object.defineProperty({}, "headers", getter("headers", headers))
      ),
    });
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    const firstRequest = wrapped.request;
    const firstResponse = wrapped.response;
    if (firstResponse?.headers !== undefined) {
      firstResponse.headers["x-provider"] = "consumer mutation";
    }

    expect(wrapped.request).toEqual({ body });
    expect(wrapped.request?.body).toBe(body);
    expect(wrapped.request).not.toBe(firstRequest);
    expect(wrapped.response).toEqual({
      headers: { "x-provider": "stable" },
    });
    expect(wrapped.response).not.toBe(firstResponse);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(reads.size).toBe(5);
  });

  it("drops invalid stream response-header names without reading values", async () => {
    let reads = 0;
    const model = textModel(["ok"]);
    const candidates = [resolved(model)];
    const firstResult = await model.doStream(callOptions);
    const headers = Object.defineProperty({}, "x".repeat(257), {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("must not be read");
      },
    });
    firstResult.response = { headers } as never;
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    expect(reads).toBe(0);
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
  });

  it("drops syntactically invalid stream headers before reading values", async () => {
    let reads = 0;
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    firstResult.response = {
      headers: Object.defineProperties(
        {},
        {
          "bad header": {
            enumerable: true,
            get() {
              reads += 1;
              throw new Error("must not be read");
            },
          },
          "x-later": {
            enumerable: true,
            value: Promise.reject(new Error("async invalid header sibling")),
          },
        }
      ),
    } as never;
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    expect(reads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes stream header Promise siblings before a value getter throws", async () => {
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    firstResult.response = {
      headers: Object.defineProperties(
        {},
        {
          "x-first": {
            enumerable: true,
            get() {
              throw new Error("stream header getter failed");
            },
          },
          "x-later": {
            enumerable: true,
            value: Promise.reject(new Error("async stream header sibling")),
          },
        }
      ),
    } as never;
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("bounds stream header keys before reading any values", async () => {
    let reads = 0;
    const headers: Record<string, string> = {};
    for (let index = 0; index < 1025; index += 1) {
      Object.defineProperty(headers, `x-${index}`, {
        enumerable: true,
        get() {
          reads += 1;
          return "value";
        },
      });
    }
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    firstResult.response = { headers };
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    expect(reads).toBe(0);
  });
});
