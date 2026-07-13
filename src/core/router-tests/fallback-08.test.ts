import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { asV4, finishReason, genOptions, okModel, usage } from "./test-kit";

describe("createRouter — fallback", () => {
  it("bounds oversized generate content and warning collections", async () => {
    const oversized = [
      {
        content: Array.from({ length: 10_001 }, () => ({
          text: "x",
          type: "text" as const,
        })),
        finishReason,
        usage,
        warnings: [],
      },
      {
        content: [{ text: "x", type: "text" as const }],
        finishReason,
        usage,
        warnings: Array.from({ length: 1025 }, () => ({
          message: "warning",
          type: "other" as const,
        })),
      },
    ];

    for (const result of oversized) {
      const secondary = okModel("bounded fallback");
      const route = createRouter({
        models: {
          chat: [
            new MockLanguageModelV4({ doGenerate: async () => result }),
            secondary,
          ],
        },
      });

      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).resolves.toMatchObject({
        content: [{ text: "bounded fallback", type: "text" }],
      });
      expect(secondary.doGenerateCalls).toHaveLength(1);
    }
  });

  it("supports a custom successful-result validator", async () => {
    const primary = okModel("reject me");
    const secondary = okModel("accepted");
    const route = createRouter({
      fallback: {
        validateResult: (result) =>
          result.content.some(
            (part) => part.type === "text" && part.text === "accepted"
          ),
      },
      models: { chat: [primary, secondary] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "accepted" });
  });

  it("records validator rejection as candidate failure and accepted fallback as request success", async () => {
    const primary = okModel("reject me");
    const secondary = okModel("accepted");
    const attempts: Array<{ index: number; outcome: string }> = [];
    const route = createRouter({
      fallback: {
        health: true,
        retryBudget: true,
        validateResult: (result) =>
          result.content.some(
            (part) => part.type === "text" && part.text === "accepted"
          ),
      },
      models: {
        chat: [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 1,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: primary,
          },
          secondary,
        ],
      },
      onAttempt: ({ index, outcome }) => attempts.push({ index, outcome }),
    });

    await expect(
      generateText({ model: route("chat"), prompt: "validate" })
    ).resolves.toMatchObject({
      text: "accepted",
    });

    expect(attempts).toEqual([
      { index: 0, outcome: "failure" },
      { index: 1, outcome: "success" },
    ]);
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(1);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    await expect(
      generateText({ model: route("chat"), prompt: "cooling" })
    ).resolves.toMatchObject({
      text: "accepted",
    });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(2);
  });

  it("isolates successful results from validator container mutation", async () => {
    const route = createRouter({
      fallback: {
        validateResult: (result) => {
          result.content.length = 0;
          result.warnings.push({
            message: "validator mutation",
            type: "other",
          });
          if (result.usage.inputTokens !== undefined) {
            result.usage.inputTokens.total = 999;
          }
          return true;
        },
      },
      models: { chat: [okModel("original result")] },
    });

    await expect(asV4(route("chat")).doGenerate(genOptions)).resolves.toEqual(
      expect.objectContaining({
        content: [{ text: "original result", type: "text" }],
        usage,
        warnings: [],
      })
    );
  });

  it("consumes rejected top-level mutations on discarded validator input", async () => {
    const route = createRouter({
      fallback: {
        validateResult: (result) => {
          const mutable = result as unknown as Record<string, unknown>;
          for (const key of [
            "content",
            "finishReason",
            "providerMetadata",
            "request",
            "response",
            "usage",
            "warnings",
          ]) {
            mutable[key] = Promise.reject(new Error(`async validator ${key}`));
          }
          return true;
        },
      },
      models: { chat: [okModel("stable")] },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "stable" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
