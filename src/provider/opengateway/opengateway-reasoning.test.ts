import type { MetadataExtractor } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  appendUniqueJsonDetails,
  collectChoiceReasoningDetails,
  createOpenGatewayMetadataExtractor,
} from "./metadata";
import { createOpenGateway } from "./opengateway";

function opengatewayReasoningResponse(): Response {
  return Response.json({
    id: "chatcmpl-og",
    object: "chat.completion",
    created: 0,
    model: "openai/gpt-5-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "visible answer",
          reasoning_content: "concise reasoning",
          reasoning_details: [
            { type: "reasoning.summary", text: "model-specific detail" },
          ],
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    extra: {
      routing: { route: "openai", model: "gpt-5-mini" },
    },
  });
}

function opengatewayReasoningDetailsOnlyResponse(): Response {
  return Response.json({
    id: "chatcmpl-og",
    object: "chat.completion",
    created: 0,
    model: "google/gemini-2.5-pro",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "visible answer",
          reasoning_details: {
            provider: "google",
            encrypted: true,
          },
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
}

function opengatewayNullReasoningDetailsResponse(): Response {
  return Response.json({
    id: "chatcmpl-og",
    object: "chat.completion",
    created: 0,
    model: "deepseek/deepseek-v4-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "visible answer",
          reasoning_details: null,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
}

function opengatewayReasoningStreamResponse(): Response {
  const events = [
    {
      id: "chatcmpl-og",
      object: "chat.completion.chunk",
      created: 0,
      model: "openai/gpt-5-mini",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_content: "streamed reasoning",
            reasoning_details: [
              { type: "reasoning.summary", text: "stream detail" },
            ],
          },
        },
      ],
    },
    {
      id: "chatcmpl-og",
      object: "chat.completion.chunk",
      created: 0,
      model: "openai/gpt-5-mini",
      choices: [{ index: 0, delta: { content: "stream answer" } }],
    },
    {
      id: "chatcmpl-og",
      object: "chat.completion.chunk",
      created: 0,
      model: "openai/gpt-5-mini",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      extra: { routing: { route: "openai", model: "gpt-5-mini" } },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OpenGateway reasoning metadata", () => {
  it("bounds and snapshots reasoning details without custom iterators", () => {
    let iterations = 0;
    const details = [{ text: "kept", type: "summary" }];
    Object.defineProperty(details, Symbol.iterator, {
      value() {
        iterations += 1;
        throw new Error("iterator must not run");
      },
    });
    const choices = [{ message: { reasoning_details: details } }];
    Object.defineProperty(choices, Symbol.iterator, {
      value() {
        iterations += 1;
        throw new Error("iterator must not run");
      },
    });

    const collected = collectChoiceReasoningDetails({ choices });
    details[0].text = "mutated";

    expect(collected).toEqual([{ text: "kept", type: "summary" }]);
    expect(iterations).toBe(0);
  });

  it("ignores cyclic and individually oversized reasoning details", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const target: import("@ai-sdk/provider").JSONValue[] = [];

    appendUniqueJsonDetails(target, [
      { text: "kept", type: "summary" },
      { type: "summary", text: "kept" },
      circular,
      "x".repeat(65_537),
    ]);

    expect(target).toEqual([{ text: "kept", type: "summary" }]);
  });

  it("consumes Promise-valued raw metadata body branches", async () => {
    expect(
      collectChoiceReasoningDetails(
        Promise.reject(new Error("async metadata body"))
      )
    ).toEqual([]);
    expect(
      collectChoiceReasoningDetails({
        choices: [
          Promise.reject(new Error("async choice one")),
          Promise.reject(new Error("async choice two")),
        ],
      })
    ).toEqual([]);

    const extractor = createOpenGatewayMetadataExtractor();
    await expect(
      extractor.extractMetadata({
        parsedBody: {
          extra: {
            routing: Promise.reject(new Error("async routing")),
          },
        },
      })
    ).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("bounds custom metadata providers before reading values", async () => {
    let reads = 0;
    const metadata = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [
        `provider-${index}`,
        { marker: index },
      ])
    );
    const hostile = new Proxy(metadata, {
      get(target, key, receiver) {
        if (typeof key === "string" && key.startsWith("provider-")) {
          reads += 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const extractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor: () => ({
        buildMetadata: () => hostile as never,
        processChunk: () => undefined,
      }),
      extractMetadata: () => Promise.resolve(hostile as never),
    });

    await expect(
      extractor.extractMetadata({
        parsedBody: { extra: { routing: { route: "safe" } } },
      })
    ).resolves.toEqual({ opengateway: { routing: { route: "safe" } } });
    expect(reads).toBe(0);
  });

  it("ignores cyclic custom metadata and preserves special provider keys", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidExtractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor: () => ({
        buildMetadata: () => ({ custom: cyclic }) as never,
        processChunk: () => undefined,
      }),
      extractMetadata: () => Promise.resolve({ custom: cyclic } as never),
    });
    await expect(
      invalidExtractor.extractMetadata({
        parsedBody: { extra: { routing: { route: "safe" } } },
      })
    ).resolves.toEqual({ opengateway: { routing: { route: "safe" } } });

    const special = Object.create(null);
    Object.defineProperty(special, "__proto__", {
      enumerable: true,
      value: { marker: "safe" },
    });
    const specialExtractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor: () => ({
        buildMetadata: () => special,
        processChunk: () => undefined,
      }),
      extractMetadata: () => Promise.resolve(special),
    });
    const metadata = await specialExtractor.extractMetadata({ parsedBody: {} });

    expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
    expect(Object.hasOwn(metadata ?? {}, "__proto__")).toBe(true);
    expect(Reflect.get(metadata ?? {}, "__proto__")).toEqual({
      marker: "safe",
    });
  });

  it("isolates failing optional metadata hooks", async () => {
    const extractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor() {
        return {
          buildMetadata() {
            throw new Error("build failed");
          },
          processChunk() {
            throw new Error("chunk failed");
          },
        };
      },
      extractMetadata() {
        return Promise.reject(new Error("extract failed"));
      },
    });

    await expect(
      extractor.extractMetadata({
        parsedBody: { extra: { routing: { route: "generate" } } },
      })
    ).resolves.toEqual({
      opengateway: { routing: { route: "generate" } },
    });

    const stream = extractor.createStreamExtractor();
    expect(() =>
      stream.processChunk({ extra: { routing: { route: "stream" } } })
    ).not.toThrow();
    expect(stream.buildMetadata()).toEqual({
      opengateway: { routing: { route: "stream" } },
    });
  });

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

  it("bounds a never-settling optional generate metadata hook", async () => {
    vi.useFakeTimers();
    try {
      const extractor = createOpenGatewayMetadataExtractor({
        createStreamExtractor: () => ({
          buildMetadata: () => undefined,
          processChunk: () => undefined,
        }),
        extractMetadata: () => new Promise(() => undefined),
      });
      const pending = extractor.extractMetadata({
        parsedBody: { extra: { routing: { route: "safe" } } },
      });

      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toEqual({
        opengateway: { routing: { route: "safe" } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes reasoning text and routing without raw reasoning_details metadata", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(opengatewayReasoningResponse());
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    const result = await generateText({
      model: opengateway("openai/gpt-5-mini"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(result.text).toBe("visible answer");
    expect(result.finalStep.reasoningText).toBe("concise reasoning");
    expect(result.finalStep.providerMetadata?.opengateway).toMatchObject({
      routing: { route: "openai", model: "gpt-5-mini" },
    });
    expect(
      result.finalStep.providerMetadata?.opengateway?.reasoningDetails
    ).toBeUndefined();
    expect(result.finalStep.reasoning).toContainEqual(
      expect.objectContaining({
        providerOptions: {
          opengateway: { reasoningDetailsRef: expect.any(String) },
        },
        text: "concise reasoning",
        type: "reasoning",
      })
    );
  });

  it("composes OpenGateway metadata with a user metadataExtractor", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(opengatewayReasoningResponse());
    const metadataExtractor: MetadataExtractor = {
      extractMetadata() {
        return Promise.resolve({
          opengateway: { custom: "kept" },
          custom: { marker: "kept" },
        });
      },
      createStreamExtractor() {
        return {
          processChunk(parsedChunk) {
            expect(parsedChunk).toBeDefined();
          },
          buildMetadata() {
            return { custom: { stream: "kept" } };
          },
        };
      },
    };
    const opengateway = createOpenGateway({
      apiKey: "k",
      fetch,
      metadataExtractor,
    });

    const result = await generateText({
      model: opengateway("openai/gpt-5-mini"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(result.finalStep.providerMetadata).toMatchObject({
      opengateway: {
        custom: "kept",
        routing: { route: "openai", model: "gpt-5-mini" },
      },
      custom: { marker: "kept" },
    });
    expect(
      result.finalStep.providerMetadata?.opengateway?.reasoningDetails
    ).toBeUndefined();
  });

  it("keeps model-specific reasoning_details ref-only without reasoning_content", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(opengatewayReasoningDetailsOnlyResponse());
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    const result = await generateText({
      model: opengateway("google/gemini-2.5-pro"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(result.text).toBe("visible answer");
    expect(result.finalStep.reasoningText).toBeUndefined();
    expect(
      result.finalStep.providerMetadata?.opengateway?.reasoningDetails
    ).toBeUndefined();
    expect(JSON.stringify(result.finalStep.response.messages)).toContain(
      "reasoningDetailsRef"
    );
    expect(JSON.stringify(result.finalStep.response.messages)).not.toContain(
      "encrypted"
    );
  });

  it("ignores null reasoning_details values", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(opengatewayNullReasoningDetailsResponse());
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    const result = await generateText({
      model: opengateway("deepseek/deepseek-v4-flash"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(result.text).toBe("visible answer");
    expect(JSON.stringify(result.finalStep.response.messages)).not.toContain(
      "reasoningDetailsRef"
    );
    expect(JSON.stringify(result.finalStep.response.messages)).not.toContain(
      "reasoning_details"
    );
  });

  it("preserves OpenGateway routing metadata on streamText results", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(opengatewayReasoningStreamResponse());
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    const result = streamText({
      model: opengateway("openai/gpt-5-mini"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(await result.text).toBe("stream answer");
    const finalStep = await result.finalStep;
    expect(finalStep.reasoning).toContainEqual(
      expect.objectContaining({
        type: "reasoning",
        text: "streamed reasoning",
      })
    );
    expect(finalStep.providerMetadata).toMatchObject({
      opengateway: {
        routing: { route: "openai", model: "gpt-5-mini" },
      },
    });
    expect(
      finalStep.providerMetadata?.opengateway?.reasoningDetails
    ).toBeUndefined();
  });
});
