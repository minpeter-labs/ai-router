import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { finishReason, runFallback, textModel, usage } from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("consumes async stream and reader method slots before fallback", async () => {
    const asyncStream = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: Promise.reject(new Error("async stream slot")),
        }) as never,
    });
    const asyncReader = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => Promise.reject(new Error("async reader result")),
          },
        }) as never,
    });
    const asyncGetReader = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: Promise.reject(new Error("async getReader slot")),
          },
        }) as never,
    });
    const asyncMethods = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => ({
              cancel: Promise.reject(new Error("async cancel slot")),
              read: Promise.reject(new Error("async read slot")),
              releaseLock: Promise.reject(new Error("async release slot")),
            }),
          },
        }) as never,
    });

    const out = await runFallback([
      asyncStream,
      asyncGetReader,
      asyncReader,
      asyncMethods,
      textModel(["recovered"]),
    ]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots read-result fields once", async () => {
    let doneReads = 0;
    let valueReads = 0;
    const first = Object.defineProperties(
      {},
      {
        done: {
          get() {
            doneReads += 1;
            return false;
          },
        },
        value: {
          get() {
            valueReads += 1;
            return { type: "stream-start", warnings: [] };
          },
        },
      }
    );
    const results = [
      first,
      { done: false, value: { type: "text-start", id: "1" } },
      { done: false, value: { type: "text-delta", delta: "safe", id: "1" } },
      { done: false, value: { type: "text-end", id: "1" } },
      { done: false, value: { type: "finish", finishReason, usage } },
    ];
    const reader = {
      cancel: () => Promise.resolve(),
      read: () => Promise.resolve(results.shift() ?? { done: true }),
      releaseLock: () => undefined,
    };
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: { getReader: () => reader } }) as never,
    });

    const out = await runFallback([model]);
    expect(out.text).toBe("safe");
    expect(doneReads).toBe(1);
    expect(valueReads).toBe(1);
  });

  it("falls back on malformed read-result envelopes", async () => {
    const malformed = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => ({
              cancel: () => Promise.resolve(),
              read: () => Promise.resolve(42),
              releaseLock: () => undefined,
            }),
          },
        }) as never,
    });

    const out = await runFallback([malformed, textModel(["recovered"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
  });

  it("consumes async read-result fields without reading inactive accessors", async () => {
    const malformed = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => ({
              cancel: () => Promise.resolve(),
              read: () =>
                Promise.resolve({
                  done: Promise.reject(new Error("async read done")),
                  value: Promise.reject(new Error("async read value")),
                }),
              releaseLock: () => undefined,
            }),
          },
        }) as never,
    });

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));

    let valueReads = 0;
    const finished = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => ({
              cancel: () => Promise.resolve(),
              read: () =>
                Promise.resolve(
                  Object.defineProperty({ done: true }, "value", {
                    get() {
                      valueReads += 1;
                      throw new Error("inactive value must not be read");
                    },
                  })
                ),
              releaseLock: () => undefined,
            }),
          },
        }) as never,
    });
    await runFallback([finished, textModel(["empty fallback"])]);
    expect(valueReads).toBe(0);
  });

  it("does not consult arbitrary read thenable extensions", async () => {
    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    const malformed = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => ({
              cancel: () => Promise.resolve(),
              read: () => extension,
              releaseLock: () => undefined,
            }),
          },
        }) as never,
    });

    const out = await runFallback([malformed, textModel(["recovered"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(thenReads).toBe(0);
  });

  it("cleans up a partially captured malformed reader", async () => {
    let cancelCalls = 0;
    let releaseCalls = 0;
    const malformed = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => ({
              cancel() {
                cancelCalls += 1;
                return Promise.resolve();
              },
              get read() {
                throw new Error("read accessor unavailable");
              },
              releaseLock() {
                releaseCalls += 1;
              },
            }),
          },
        }) as never,
    });

    const out = await runFallback([malformed, textModel(["recovered"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(cancelCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });
});
