import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { finishReason, okModel, usage } from "./test-kit";

describe("createRouter — fallback", () => {
  it("consumes every rejected nested usage field before fallback", async () => {
    let thenReads = 0;
    const arbitraryThenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        return () => undefined;
      },
    });
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [{ text: "unusable", type: "text" }],
          finishReason,
          usage: {
            inputTokens: {
              cacheRead: Promise.reject(new Error("async cache read")),
              cacheWrite: Promise.reject(new Error("async cache write")),
              noCache: arbitraryThenable,
              total: 10,
            },
            outputTokens: {
              reasoning: Promise.reject(new Error("async reasoning tokens")),
              text: Promise.reject(new Error("async text tokens")),
              total: 20,
            },
            raw: {
              first: Promise.reject(new Error("async raw usage first")),
              second: Promise.reject(new Error("async raw usage second")),
            },
          },
          warnings: [],
        }) as never,
    });
    const route = createRouter({
      models: { chat: [primary, okModel("nested async fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "nested async fallback" });
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected nested fields across generate metadata branches", async () => {
    const rejected = (label: string) => Promise.reject(new Error(label));
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [
            {
              providerMetadata: rejected("async content metadata"),
              text: rejected("async content text"),
              type: "text",
            },
            rejected("async content part"),
          ],
          finishReason,
          response: {
            headers: {
              "x-first": rejected("async first header"),
              "x-second": rejected("async second header"),
            },
          },
          usage,
          warnings: [
            {
              details: rejected("async warning details"),
              feature: rejected("async warning feature"),
              type: "unsupported",
            },
            rejected("async warning entry"),
          ],
        }) as never,
    });
    const route = createRouter({
      models: { chat: [primary, okModel("nested branch fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "nested branch fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected Promises nested across generate JSON branches", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [{ text: "unusable", type: "text" }],
          finishReason,
          providerMetadata: {
            mock: {
              first: Promise.reject(new Error("async provider JSON first")),
              second: Promise.reject(new Error("async provider JSON second")),
            },
          },
          request: {
            body: {
              nested: Promise.reject(new Error("async request JSON")),
            },
          },
          response: {
            body: {
              nested: Promise.reject(new Error("async response JSON")),
            },
            headers: {
              "x-first": Promise.reject(new Error("async response header one")),
              "x-second": Promise.reject(
                new Error("async response header two")
              ),
            },
          },
          usage: {
            ...usage,
            raw: {
              nested: Promise.reject(new Error("async usage JSON")),
            },
          },
          warnings: [],
        }) as never,
    });
    const route = createRouter({
      models: { chat: [primary, okModel("nested JSON fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "nested JSON fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected nested branches within one generated content part", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [
            {
              providerMetadata: {
                mock: Promise.reject(new Error("async part metadata JSON")),
              },
              result: {
                first: Promise.reject(new Error("async tool result first")),
                second: Promise.reject(new Error("async tool result second")),
              },
              toolCallId: "call",
              toolName: "tool",
              type: "tool-result",
            },
          ],
          finishReason,
          usage,
          warnings: [],
        }) as never,
    });
    const route = createRouter({
      models: { chat: [primary, okModel("content branch fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "content branch fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("falls back on cyclic provider JSON payloads", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const variants = [
      { providerMetadata: { mock: circular } },
      { usage: { ...usage, raw: circular } },
      {
        content: [
          {
            result: circular,
            toolCallId: "call",
            toolName: "tool",
            type: "tool-result",
          },
        ],
      },
    ];

    for (const variant of variants) {
      const primary = new MockLanguageModelV4({
        doGenerate: async () =>
          ({
            content: [{ text: "unusable", type: "text" }],
            finishReason,
            usage,
            warnings: [],
            ...variant,
          }) as never,
      });
      const fallback = okModel("json fallback");
      const route = createRouter({ models: { chat: [primary, fallback] } });

      await expect(
        generateText({ model: route("chat"), prompt: "hi" })
      ).resolves.toMatchObject({ text: "json fallback" });
    }
  });
});
