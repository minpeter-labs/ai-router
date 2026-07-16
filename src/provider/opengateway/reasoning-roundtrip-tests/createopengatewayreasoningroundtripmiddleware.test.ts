import { describe, expect, it, vi } from "vitest";
import { createOpenGatewayReasoningRoundtripMiddleware } from "../reasoning-roundtrip";

describe("createOpenGatewayReasoningRoundtripMiddleware", () => {
  it("consumes Promise-valued settings and store slots", async () => {
    expect(() =>
      createOpenGatewayReasoningRoundtripMiddleware(
        Promise.reject(new Error("async middleware settings")) as never
      )
    ).toThrow("reasoning roundtrip settings must be synchronous");
    expect(() =>
      createOpenGatewayReasoningRoundtripMiddleware({
        reasoningDetailsStore: Promise.reject(
          new Error("async configured store")
        ) as never,
      })
    ).toThrow("reasoningDetailsStore must be synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes Promise-valued hook argument siblings before invocation", async () => {
    const middleware = createOpenGatewayReasoningRoundtripMiddleware();
    await expect(
      middleware.transformParams?.(
        Promise.reject(new Error("async transform arguments")) as never
      )
    ).rejects.toThrow("hook arguments must be synchronous");

    const generateOptions = Object.defineProperties(
      {},
      {
        doGenerate: {
          get() {
            throw new Error("generate accessor failed");
          },
        },
        doStream: {
          value: Promise.reject(new Error("async stream sibling")),
        },
      }
    );
    await expect(
      middleware.wrapGenerate?.(generateOptions as never)
    ).rejects.toThrow("generate accessor failed");

    await expect(
      middleware.wrapStream?.({
        doGenerate: Promise.reject(new Error("async generate sibling")),
        doStream: () => Promise.reject(new Error("unused")),
        model: {
          doStream: Promise.reject(new Error("async model method")),
        },
        params: Promise.reject(new Error("async params")),
      } as never)
    ).rejects.toThrow("hook fields must be synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes Promise-valued generate and stream result siblings", async () => {
    const middleware = createOpenGatewayReasoningRoundtripMiddleware();
    await expect(
      middleware.wrapGenerate?.({
        doGenerate: () =>
          Promise.resolve({
            content: Promise.reject(new Error("async content")),
            finishReason: Promise.reject(new Error("async finish reason")),
            usage: Promise.reject(new Error("async usage")),
            warnings: Promise.reject(new Error("async warnings")),
          } as never),
        doStream: () => Promise.reject(new Error("unused")),
        model: {} as never,
        params: { prompt: [] },
      })
    ).rejects.toThrow("reasoning generate result fields must be synchronous");

    await expect(
      middleware.wrapGenerate?.({
        doGenerate: () =>
          Promise.resolve({
            content: [],
            finishReason: { raw: "stop", unified: "stop" },
            response: {
              body: Promise.reject(new Error("async response body")),
              headers: Promise.reject(new Error("async response headers")),
            },
            usage: {},
            warnings: [],
          } as never),
        doStream: () => Promise.reject(new Error("unused")),
        model: {} as never,
        params: { prompt: [] },
      })
    ).rejects.toThrow("reasoning generate response fields must be synchronous");

    await expect(
      middleware.wrapStream?.({
        doGenerate: () => Promise.reject(new Error("unused")),
        doStream: () => Promise.reject(new Error("unused")),
        model: {
          doStream: () =>
            Promise.resolve({
              request: Promise.reject(new Error("async request")),
              response: Promise.reject(new Error("async response")),
              stream: Promise.reject(new Error("async stream")),
            } as never),
        } as never,
        params: { prompt: [] },
      })
    ).rejects.toThrow("reasoning stream result fields must be synchronous");

    await expect(
      middleware.wrapStream?.({
        doGenerate: () => Promise.reject(new Error("unused")),
        doStream: () => Promise.reject(new Error("unused")),
        model: {
          doStream: () =>
            Promise.resolve({
              stream: {
                pipeThrough: Promise.reject(
                  new Error("async pipeThrough method")
                ),
              },
            } as never),
        } as never,
        params: { prompt: [] },
      })
    ).rejects.toThrow("result.stream.pipeThrough must be a function");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("cancels opened streams when transform setup fails", async () => {
    const middleware = createOpenGatewayReasoningRoundtripMiddleware();
    const OriginalTransformStream = globalThis.TransformStream;
    let cancellations = 0;
    const source = new ReadableStream({
      cancel() {
        cancellations += 1;
      },
    });
    vi.stubGlobal(
      "TransformStream",
      class {
        constructor() {
          throw new Error("transform unavailable");
        }
      }
    );
    try {
      await expect(
        middleware.wrapStream?.({
          doGenerate: () => Promise.reject(new Error("unused")),
          doStream: () => Promise.reject(new Error("unused")),
          model: {
            doStream: () => Promise.resolve({ stream: source }),
          } as never,
          params: { prompt: [] },
        })
      ).rejects.toThrow("transform unavailable");
      expect(cancellations).toBe(1);
    } finally {
      vi.stubGlobal("TransformStream", OriginalTransformStream);
    }

    let customCancellations = 0;
    await expect(
      middleware.wrapStream?.({
        doGenerate: () => Promise.reject(new Error("unused")),
        doStream: () => Promise.reject(new Error("unused")),
        model: {
          doStream: () =>
            Promise.resolve({
              stream: {
                cancel() {
                  customCancellations += 1;
                  return Promise.resolve();
                },
                pipeThrough() {
                  return Promise.reject(new Error("async pipe result"));
                },
              },
            } as never),
        } as never,
        params: { prompt: [] },
      })
    ).rejects.toThrow("pipeThrough must return a synchronous stream");
    expect(customCancellations).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
