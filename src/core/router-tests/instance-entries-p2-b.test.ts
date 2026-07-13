import type { LanguageModelV4 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { asV4, failingModel, genOptions, NOT_V4_RE, okModel } from "./test-kit";

describe("createRouter — instance entries (P2-B)", () => {
  it("accepts an instance-object entry { model: <instance> }", async () => {
    const route = createRouter({
      models: { chat: [{ model: okModel("inst") }] },
    });
    const { text } = await generateText({ model: route("chat"), prompt: "hi" });
    expect(text).toBe("inst");
  });

  it("accepts a bare instance shorthand", async () => {
    const route = createRouter({
      models: { chat: [okModel("bare")] },
    });
    const { text } = await generateText({ model: route("chat"), prompt: "hi" });
    expect(text).toBe("bare");
  });

  it("falls back across a mix of instance and factory entries", async () => {
    const primary = failingModel("overloaded");
    const route = createRouter({
      models: {
        chat: [
          { model: primary }, // instance object
          {
            provider: () => okModel("factory"),
            model: "f",
            supports: ["text"],
          }, // factory
        ],
      },
    });
    const { text } = await generateText({ model: route("chat"), prompt: "hi" });
    expect(text).toBe("factory");
  });

  it("throws a clear error for a non-v4 instance entry", async () => {
    const stub = { specificationVersion: "v3" } as unknown as LanguageModelV4;
    const route = createRouter({
      models: { chat: [{ model: stub }] },
    });
    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toThrow(
      NOT_V4_RE
    );
  });
});
