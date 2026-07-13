import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import { wrapStreamResult } from "../stream";
import {
  callOptions,
  chunkModel,
  drive,
  finishReason,
  resolved,
  runFallback,
  textModel,
  usage,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("cancels an opened stream when reader capture fails", async () => {
    const cancelled: unknown[] = [];
    const malformed = new MockLanguageModelV4({
      doStream: () => {
        const stream = {
          cancel(this: unknown, reason: unknown) {
            expect(this).toBe(stream);
            cancelled.push(reason);
            return Promise.reject(new Error("cleanup rejection"));
          },
          get getReader() {
            throw new Error("reader unavailable");
          },
        };
        return Promise.resolve({ stream } as never);
      },
    });

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("cancels a stream whose getReader returns an invalid value", async () => {
    let cancelCalls = 0;
    const malformed = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            cancel() {
              cancelCalls += 1;
              return Promise.resolve();
            },
            getReader: () => null,
          },
        }) as never,
    });

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(cancelCalls).toBe(1);
  });

  it("isolates ordinary text deltas from later provider mutation", async () => {
    const delta: Extract<LanguageModelV4StreamPart, { type: "text-delta" }> = {
      delta: "stable",
      id: "1",
      type: "text-delta",
    };
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      delta,
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);
    delta.delta = "mutated";

    expect(out.text).toBe("stable");
    expect(out.parts).not.toContain(delta);
  });

  it("isolates throwing optional request and response metadata getters", async () => {
    const model = textModel(["ok"]);
    const candidates = [resolved(model)];
    const firstResult = await model.doStream(callOptions);
    Object.defineProperties(firstResult, {
      request: {
        get() {
          throw new Error("request metadata failed");
        },
      },
      response: {
        get() {
          throw new Error("response metadata failed");
        },
      },
    });
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.request).toBeUndefined();
    expect(wrapped.response).toBeUndefined();
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
  });

  it("consumes rejected Promise stream metadata without reading thenables", async () => {
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    firstResult.request = Promise.reject(
      new Error("async request metadata unsupported")
    ) as never;
    firstResult.response = Promise.reject(
      new Error("async response metadata unsupported")
    ) as never;
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.request).toBeUndefined();
    expect(wrapped.response).toBeUndefined();
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    let reads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        reads += 1;
        throw new Error("then extension must not run");
      },
    });
    const thenResult = await model.doStream(callOptions);
    thenResult.request = thenable as never;
    const thenWrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult: thenResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });
    await expect(drive(thenWrapped.stream)).resolves.toMatchObject({
      text: "ok",
    });
    expect(reads).toBe(0);
  });

  it("consumes every rejected stream response-header value", async () => {
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    firstResult.response = {
      headers: {
        "x-first": Promise.reject(new Error("async first stream header")),
        "x-second": Promise.reject(new Error("async second stream header")),
      },
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

  it("sanitizes nested stream request and response metadata", async () => {
    const model = textModel(["ok"]);
    const candidates = [resolved(model)];
    const firstResult = await model.doStream(callOptions);
    firstResult.request = Object.defineProperty({}, "body", {
      get() {
        throw new Error("request body failed");
      },
    });
    firstResult.response = {
      headers: Object.defineProperty({}, "x-hostile", {
        enumerable: true,
        get() {
          throw new Error("header failed");
        },
      }),
    } as never;
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.request).toBeUndefined();
    expect(wrapped.response).toBeUndefined();
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
  });
});
