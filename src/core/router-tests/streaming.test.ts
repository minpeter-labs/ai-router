import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import { streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  failingStreamModel,
  finishReason,
  promiseLike,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — streaming", () => {
  it("streams via the routed model", async () => {
    const model = streamingModel(["Hello", ", world!"]);
    const route = createRouter({
      models: {
        chat: [{ provider: () => model, model: "m", supports: ["text"] }],
      },
    });

    const acc = await collectStream(
      streamText({ model: route("chat"), prompt: "hi" })
    );
    expect(acc).toBe("Hello, world!");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("accepts a provider doStream PromiseLike result", async () => {
    const model = {
      specificationVersion: "v4" as const,
      modelId: "promise-like",
      provider: "mock",
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error("unused")),
      doStream: () =>
        promiseLike({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { id: "1", type: "text-start" as const },
              { delta: "promise-like", id: "1", type: "text-delta" as const },
              { id: "1", type: "text-end" as const },
              { finishReason, type: "finish" as const, usage },
            ],
          }),
        }),
    } satisfies LanguageModelV4;
    const route = createRouter({ models: { chat: [model] } });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("promise-like");
  });

  it("falls back to the secondary when the primary doStream throws", async () => {
    const primary = failingStreamModel("stream 503");
    const secondary = streamingModel(["from ", "secondary"]);
    const errors: unknown[] = [];

    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
      onError: ({ error }) => errors.push(error),
    });

    const acc = await collectStream(
      streamText({ model: route("chat"), prompt: "hi" })
    );
    expect(acc).toBe("from secondary");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("stream 503");
  });

  it("isolates mutable call options across mid-stream fallback", async () => {
    const primary = new MockLanguageModelV4({
      doStream: (options) => {
        const message = options.prompt[0];
        if (message.role !== "system") {
          (message.content[0] as { text?: string }).text = "mutated";
          message.content.length = 0;
        }
        options.prompt.length = 0;
        if (options.headers !== undefined) {
          options.headers.authorization = "mutated";
        }
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { error: new Error("stream failed"), type: "error" },
            ],
          }),
        });
      },
    });
    const secondary = new MockLanguageModelV4({
      doStream: (options) => {
        expect(options.prompt).toEqual([
          {
            content: [{ text: "original", type: "text" }],
            role: "user",
          },
        ]);
        expect(options.headers).toEqual({ authorization: "original" });
        return streamingModel(["isolated stream"]).doStream(options);
      },
    });
    const options: LanguageModelV4CallOptions = {
      headers: { authorization: "original" },
      prompt: [
        {
          content: [{ text: "original", type: "text" }],
          role: "user",
        },
      ],
    };
    const route = createRouter({ models: { chat: [primary, secondary] } });

    const result = await asV4(route("chat")).doStream(options);
    let text = "";
    for await (const part of result.stream) {
      if (part.type === "text-delta") {
        text += part.delta;
      }
    }

    expect(text).toBe("isolated stream");
    expect(options.prompt[0]).toMatchObject({
      content: [{ text: "original", type: "text" }],
    });
    expect(options.headers).toEqual({ authorization: "original" });
  });

  it("allows a custom classifier to retry a provider-origin stream abort", async () => {
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "error",
              error: new DOMException("provider stream stopped", "AbortError"),
            },
          ],
        }),
      }),
    });
    const secondary = streamingModel(["stream recovered"]);
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({ retryable: true, scope: "transient" }),
      },
      models: { chat: [primary, secondary] },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("stream recovered");
    expect(secondary.doStreamCalls).toHaveLength(1);
  });
});
