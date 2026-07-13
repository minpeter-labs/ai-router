import { describe, expect, it, vi } from "vitest";
import { createOpenGatewayMetadataExtractor } from "../metadata";

describe("OpenGateway reasoning metadata", () => {
  it("consumes Promise-valued optional metadata method slots before accessor failures", async () => {
    const userExtractor = Object.defineProperties(
      {},
      {
        createStreamExtractor: {
          get() {
            throw new Error("stream extractor accessor failed");
          },
        },
        extractMetadata: {
          value: Promise.reject(new Error("async extract method slot")),
        },
      }
    );
    const extractor = createOpenGatewayMetadataExtractor(
      userExtractor as never
    );

    await expect(
      extractor.extractMetadata({
        parsedBody: { extra: { routing: { route: "generate" } } },
      })
    ).resolves.toEqual({
      opengateway: { routing: { route: "generate" } },
    });

    const streamSource = Object.defineProperties(
      {},
      {
        buildMetadata: {
          value: Promise.reject(new Error("async build method slot")),
        },
        processChunk: {
          get() {
            throw new Error("process accessor failed");
          },
        },
      }
    );
    const streamExtractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor: () => streamSource as never,
      extractMetadata: () => Promise.resolve(undefined),
    }).createStreamExtractor();
    streamExtractor.processChunk({
      extra: { routing: { route: "stream" } },
    });
    expect(streamExtractor.buildMetadata()).toEqual({
      opengateway: { routing: { route: "stream" } },
    });

    const asyncSource = createOpenGatewayMetadataExtractor({
      createStreamExtractor: (() =>
        Promise.reject(new Error("async stream extractor"))) as never,
      extractMetadata: () => Promise.resolve(undefined),
    }).createStreamExtractor();
    expect(asyncSource.buildMetadata()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected async results from sync stream metadata hooks", async () => {
    const extractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor() {
        return {
          buildMetadata: (() =>
            Promise.reject(new Error("async build"))) as never,
          processChunk: (() =>
            Promise.reject(new Error("async chunk"))) as never,
        };
      },
      extractMetadata: () => Promise.resolve(undefined),
    });
    const stream = extractor.createStreamExtractor();

    stream.processChunk({ extra: { routing: { route: "safe" } } });
    expect(stream.buildMetadata()).toEqual({
      opengateway: { routing: { route: "safe" } },
    });
    await Promise.resolve();
  });

  it("bounds late-mutation retention for a never-settling stream metadata hook", () => {
    vi.useFakeTimers();
    try {
      const extractor = createOpenGatewayMetadataExtractor({
        createStreamExtractor: () => ({
          buildMetadata: () => undefined,
          processChunk: (() => new Promise(() => undefined)) as never,
        }),
        extractMetadata: () => Promise.resolve(undefined),
      }).createStreamExtractor();

      extractor.processChunk({ stable: { value: true } });
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates user metadata hooks from SDK-owned raw response values", async () => {
    const generateBody = {
      extra: { routing: { route: "generate" } },
      stable: { value: true },
    };
    const streamChunk = {
      extra: { routing: { route: "stream" } },
      stable: { value: true },
    };
    const extractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor: () => ({
        buildMetadata: () => undefined,
        async processChunk(parsedChunk) {
          await Promise.resolve();
          (parsedChunk as typeof streamChunk).stable.value = Promise.reject(
            new Error("async stream input mutation")
          ) as never;
        },
      }),
      async extractMetadata({ parsedBody }) {
        await Promise.resolve();
        (parsedBody as typeof generateBody).stable.value = Promise.reject(
          new Error("async generate input mutation")
        ) as never;
      },
    });

    await expect(
      extractor.extractMetadata({ parsedBody: generateBody })
    ).resolves.toEqual({
      opengateway: { routing: { route: "generate" } },
    });
    const stream = extractor.createStreamExtractor();
    stream.processChunk(streamChunk);
    await Promise.resolve();

    expect(generateBody.stable.value).toBe(true);
    expect(streamChunk.stable.value).toBe(true);
    expect(stream.buildMetadata()).toEqual({
      opengateway: { routing: { route: "stream" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("skips user metadata hooks for asynchronous raw inputs", async () => {
    let generateCalls = 0;
    let streamCalls = 0;
    const extractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor: () => ({
        buildMetadata: () => undefined,
        processChunk() {
          streamCalls += 1;
        },
      }),
      extractMetadata() {
        generateCalls += 1;
        return Promise.resolve(undefined);
      },
    });

    await expect(
      extractor.extractMetadata({
        parsedBody: {
          async: Promise.reject(new Error("async generate body")),
          extra: { routing: { route: "generate" } },
        },
      })
    ).resolves.toBeUndefined();
    const stream = extractor.createStreamExtractor();
    stream.processChunk({
      async: Promise.reject(new Error("async stream chunk")),
      extra: { routing: { route: "stream" } },
    });

    expect(generateCalls).toBe(0);
    expect(streamCalls).toBe(0);
    expect(stream.buildMetadata()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not consult arbitrary generate metadata thenable extensions", async () => {
    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    const extractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor: () => ({
        buildMetadata: () => undefined,
        processChunk: () => undefined,
      }),
      extractMetadata: (() => extension) as never,
    });

    await expect(
      extractor.extractMetadata({
        parsedBody: { extra: { routing: { route: "safe" } } },
      })
    ).resolves.toEqual({
      opengateway: { routing: { route: "safe" } },
    });
    expect(thenReads).toBe(0);
  });
});
