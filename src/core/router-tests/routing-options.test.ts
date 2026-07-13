import type { LanguageModelV4 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { okModel } from "./test-kit";

describe("createRouter — routing & options", () => {
  it("falls back without executing provider thenable extensions", async () => {
    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    const malformed = {
      specificationVersion: "v4" as const,
      modelId: "thenable",
      provider: "mock",
      supportedUrls: {},
      doGenerate: () => thenable as never,
      doStream: () => Promise.reject(new Error("unused")),
    } satisfies LanguageModelV4;
    const survivor = okModel("recovered");
    const route = createRouter({ models: { chat: [malformed, survivor] } });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "recovered" });
    expect(thenReads).toBe(0);
    expect(survivor.doGenerateCalls).toHaveLength(1);
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
