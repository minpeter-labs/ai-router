import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import {
  collectStream,
  finishReason,
  okModel,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — lazy instantiation & caching", () => {
  it("snapshots model method accessors once and preserves original this", async () => {
    const reads = {
      doGenerate: 0,
      doStream: 0,
      modelId: 0,
      provider: 0,
      specificationVersion: 0,
      supportedUrls: 0,
    };
    const raw = Object.defineProperties(
      {},
      {
        doGenerate: {
          get() {
            reads.doGenerate += 1;
            if (reads.doGenerate > 1) {
              throw new Error("doGenerate read twice");
            }
            return function (this: unknown) {
              if (this !== raw) {
                throw new Error("generate this binding lost");
              }
              return Promise.resolve({
                content: [{ text: "bound generate", type: "text" as const }],
                finishReason,
                usage,
                warnings: [],
              });
            };
          },
        },
        doStream: {
          get() {
            reads.doStream += 1;
            if (reads.doStream > 1) {
              throw new Error("doStream read twice");
            }
            return function (
              this: unknown,
              options: LanguageModelV4CallOptions
            ) {
              if (this !== raw) {
                throw new Error("stream this binding lost");
              }
              return streamingModel(["bound stream"]).doStream(options);
            };
          },
        },
        modelId: {
          get() {
            reads.modelId += 1;
            if (reads.modelId > 1) {
              throw new Error("modelId read twice");
            }
            return "stateful";
          },
        },
        provider: {
          get() {
            reads.provider += 1;
            if (reads.provider > 1) {
              throw new Error("provider read twice");
            }
            return "mock";
          },
        },
        specificationVersion: {
          get() {
            reads.specificationVersion += 1;
            if (reads.specificationVersion > 1) {
              throw new Error("specificationVersion read twice");
            }
            return "v4";
          },
        },
        supportedUrls: {
          get() {
            reads.supportedUrls += 1;
            if (reads.supportedUrls > 1) {
              throw new Error("supportedUrls read twice");
            }
            return {};
          },
        },
      }
    );
    const model = raw as unknown as LanguageModelV4;
    const route = createRouter({ models: { chat: [model] } });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "bound generate" });
    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("bound stream");
    expect(reads).toEqual({
      doGenerate: 1,
      doStream: 1,
      modelId: 1,
      provider: 1,
      specificationVersion: 1,
      supportedUrls: 1,
    });
  });

  it("does not instantiate any provider until a request is made", () => {
    let factoryCalls = 0;
    const route = createRouter({
      models: {
        chat: [
          {
            provider: () => {
              factoryCalls++;
              return okModel();
            },
            model: "m",
            supports: ["text"],
          },
        ],
      },
    });

    // Resolving the logical id is cheap — no provider is built yet.
    route("chat");
    expect(factoryCalls).toBe(0);
  });

  it("instantiates each provider factory at most once across many requests on a routed model", async () => {
    let factoryCalls = 0;
    const model = okModel("cached");
    const route = createRouter({
      models: {
        chat: [
          {
            provider: () => {
              factoryCalls++;
              return model;
            },
            model: "m",
            supports: ["text"],
          },
        ],
      },
    });

    // A single routed model is reused for multiple requests; the underlying
    // factory is invoked lazily on the first request and cached thereafter.
    const routed = route("chat");
    await generateText({ model: routed, prompt: "a" });
    await generateText({ model: routed, prompt: "b" });
    await generateText({ model: routed, prompt: "c" });

    expect(factoryCalls).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it("only instantiates the candidates actually attempted (lazy fallback)", async () => {
    let primaryBuilt = 0;
    let secondaryBuilt = 0;
    const primary = okModel("primary");
    const secondary = okModel("secondary");

    const route = createRouter({
      models: {
        chat: [
          {
            provider: () => {
              primaryBuilt++;
              return primary;
            },
            model: "p",
            supports: ["text"],
          },
          {
            provider: () => {
              secondaryBuilt++;
              return secondary;
            },
            model: "s",
            supports: ["text"],
          },
        ],
      },
    });

    await generateText({ model: route("chat"), prompt: "hi" });

    // Candidates are instantiated lazily, only when actually attempted: the
    // primary succeeds, so the secondary's factory is never invoked.
    expect(primaryBuilt).toBe(1);
    expect(secondaryBuilt).toBe(0);
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(0);
  });

  it("does not let a broken later candidate abort a request a healthy earlier one can serve", async () => {
    const healthy = okModel("healthy");
    const stub = { specificationVersion: "v3" } as unknown as LanguageModelV4;

    const route = createRouter({
      models: {
        chat: [
          { provider: () => healthy, model: "h", supports: ["text"] },
          { model: stub, supports: ["text"] }, // non-v4 instance — would throw if instantiated
        ],
      },
    });

    // The healthy primary serves; the broken sibling is never instantiated.
    const { text } = await generateText({ model: route("chat"), prompt: "hi" });
    expect(text).toBe("healthy");
    expect(healthy.doGenerateCalls).toHaveLength(1);
  });
});
