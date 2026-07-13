import type { LanguageModelV4 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { finishReason, okModel, promiseLike, usage } from "./test-kit";

describe("createRouter — routing & options", () => {
  it("accepts a provider doGenerate PromiseLike result", async () => {
    const primary = {
      specificationVersion: "v4" as const,
      modelId: "promise-like",
      provider: "mock",
      supportedUrls: {},
      doGenerate: () =>
        promiseLike({
          content: [{ text: "promise-like", type: "text" as const }],
          finishReason,
          usage,
          warnings: [],
        }),
      doStream: () => Promise.reject(new Error("unused")),
    } satisfies LanguageModelV4;
    const survivor = okModel("must not run");
    const route = createRouter({ models: { chat: [primary, survivor] } });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "promise-like" });
    expect(survivor.doGenerateCalls).toHaveLength(0);
  });

  it("routes to the first matching entry and forwards options", async () => {
    const primary = okModel("primary");
    const secondary = okModel("secondary");
    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
    });

    const { text } = await generateText({
      model: route("chat"),
      prompt: "hi",
      temperature: 0.42,
    });

    // First matching entry wins; the second is never consulted.
    expect(text).toBe("primary");
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(0);

    // Call options are forwarded verbatim to the underlying model.
    expect(primary.doGenerateCalls[0].temperature).toBe(0.42);
  });
});
