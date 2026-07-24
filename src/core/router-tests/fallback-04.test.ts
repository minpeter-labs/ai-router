import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { asV4, finishReason, genOptions, okModel, usage } from "./test-kit";

describe("createRouter — fallback", () => {
  it("falls back on malformed generate envelopes before the SDK consumes them", async () => {
    const malformedResults = [
      { content: undefined, finishReason, usage, warnings: [] },
      {
        content: [{ type: "unknown" }],
        finishReason,
        usage,
        warnings: [],
      },
      {
        content: [{ type: "tool-call" }],
        finishReason,
        usage,
        warnings: [],
      },
      {
        content: [
          { input: "{}", toolCallId: "", toolName: "tool", type: "tool-call" },
        ],
        finishReason,
        usage,
        warnings: [],
      },
      {
        content: [
          {
            input: "{}",
            toolCallId: "x".repeat(4097),
            toolName: "tool",
            type: "tool-call",
          },
        ],
        finishReason,
        usage,
        warnings: [],
      },
      {
        content: [{ kind: "invalid", type: "custom" }],
        finishReason,
        usage,
        warnings: [],
      },
      {
        content: [
          {
            data: {},
            mediaType: "image/png",
            type: "file",
          },
        ],
        finishReason,
        usage,
        warnings: [],
      },
      {
        content: [
          {
            input: "{}",
            providerExecuted: "yes",
            toolCallId: "call",
            toolName: "tool",
            type: "tool-call",
          },
        ],
        finishReason,
        usage,
        warnings: [],
      },
      {
        content: [
          {
            id: "source",
            providerMetadata: "invalid",
            sourceType: "url",
            title: 42,
            type: "source",
            url: "https://example.com",
          },
        ],
        finishReason,
        usage,
        warnings: [],
      },
      {
        content: [
          { type: "tool-call", toolCallId: "same", toolName: "a", input: "{}" },
          { type: "tool-call", toolCallId: "same", toolName: "b", input: "{}" },
        ],
        finishReason,
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "bad" }],
        finishReason,
        usage,
        warnings: [{ type: "other" }],
      },
      {
        content: [{ type: "text", text: "bad" }],
        finishReason,
        usage,
        warnings: [{ message: "x".repeat(65_537), type: "other" }],
      },
      {
        content: [{ type: "text", text: "bad" }],
        finishReason,
        usage,
        warnings: Array.from({ length: 17 }, () => ({
          message: "x".repeat(65_536),
          type: "other" as const,
        })),
      },
      {
        content: [{ type: "text", text: "bad" }],
        finishReason,
        usage,
        warnings: new Array(1),
      },
      {
        content: [{ type: "text", text: "bad" }],
        finishReason,
        usage,
        warnings: new Array(1_000_000),
      },
      {
        content: [{ type: "text", text: "bad" }],
        finishReason: { raw: "bad", unified: "invalid" },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "bad" }],
        finishReason,
        usage: {
          ...usage,
          outputTokens: { ...usage.outputTokens, total: Number.NaN },
        },
        warnings: [],
      },
    ];

    for (const malformed of malformedResults) {
      const primary = new MockLanguageModelV4({
        doGenerate: () => Promise.resolve(malformed as never),
      });
      const secondary = okModel("valid");
      const route = createRouter({ models: { chat: [primary, secondary] } });

      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "valid" }],
      });
      expect(secondary.doGenerateCalls).toHaveLength(1);
    }
  });

  it("rejects non-string generate discriminants without coercion", async () => {
    let coercions = 0;
    const hostile = {
      toString() {
        coercions += 1;
        return "text";
      },
    };
    for (const malformed of [
      {
        content: [{ text: "bad", type: hostile }],
        finishReason,
        usage,
        warnings: [],
      },
      {
        content: [{ text: "bad", type: "text" }],
        finishReason: { raw: "stop", unified: hostile },
        usage,
        warnings: [],
      },
      {
        content: [{ text: "bad", type: "text" }],
        finishReason,
        usage,
        warnings: [{ message: "bad", type: hostile }],
      },
    ]) {
      const route = createRouter({
        models: {
          chat: [
            new MockLanguageModelV4({
              doGenerate: () => Promise.resolve(malformed as never),
            }),
            okModel("recovered"),
          ],
        },
      });
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).resolves.toMatchObject({ content: [{ text: "recovered" }] });
    }
    expect(coercions).toBe(0);
  });
});
