import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  EXAMPLE_HTTPS_RE,
  finishReason,
  HTTPS_A_RE,
  MUTABLE_EXAMPLE_RE,
  okModel,
  usage,
} from "./test-kit";

describe("createRouter — supportedUrls", () => {
  function urlModel(id: string, supportedUrls: Record<string, RegExp[]>) {
    return new MockLanguageModelV4({
      provider: "mock",
      modelId: id,
      supportedUrls,
      doGenerate: async () => ({
        content: [{ type: "text", text: id }],
        finishReason,
        usage,
        warnings: [],
      }),
    });
  }

  it("reports NO native URL support for a multi-candidate router (SDK inlines)", async () => {
    // The router cannot know which candidate will serve, so it claims no URL
    // support and lets the SDK download+inline — and it does so WITHOUT
    // instantiating the candidates (lazy: only computed once, no factory calls).
    let built = 0;
    const route = createRouter({
      models: {
        chat: [
          {
            provider: () => {
              built++;
              return urlModel("first", { "image/*": [HTTPS_A_RE] });
            },
            model: "f",
            supports: ["text", "image"],
          },
          {
            provider: () => {
              built++;
              return urlModel("second", { "image/*": [HTTPS_A_RE] });
            },
            model: "s",
            supports: ["text", "image"],
          },
        ],
      },
    });
    expect(await asV4(route("chat")).supportedUrls).toEqual({});
    expect(built).toBe(0);
  });

  it("reports a single candidate's own support unchanged", async () => {
    const withUrls = createRouter({
      models: {
        chat: [
          {
            provider: () => urlModel("m", { "image/*": [EXAMPLE_HTTPS_RE] }),
            model: "m",
            supports: ["text", "image"],
          },
        ],
      },
    });
    expect(await asV4(withUrls("chat")).supportedUrls).toEqual({
      "image/*": [EXAMPLE_HTTPS_RE],
    });

    const withNone = createRouter({
      models: {
        chat: [
          { provider: () => urlModel("n", {}), model: "n", supports: ["text"] },
        ],
      },
    });
    expect(await asV4(withNone("chat")).supportedUrls).toEqual({});
  });

  it("memoizes an undefined supportedUrls value", () => {
    let reads = 0;
    const model = okModel();
    Object.defineProperty(model, "supportedUrls", {
      configurable: true,
      get() {
        reads += 1;
        return;
      },
    });
    const route = createRouter({ models: { chat: [model] } });
    const routed = asV4(route("chat"));

    expect(routed.supportedUrls).toEqual({});
    expect(routed.supportedUrls).toEqual({});
    expect(reads).toBe(1);
  });

  it("fails closed when async supportedUrls discovery rejects", async () => {
    const model = okModel("still usable");
    Object.defineProperty(model, "supportedUrls", {
      configurable: true,
      value: Promise.reject(new Error("capability lookup failed")),
    });
    const route = createRouter({ models: { chat: [model] } });
    const routed = asV4(route("chat"));

    await expect(routed.supportedUrls).resolves.toEqual({});
    await expect(
      generateText({ model: routed, prompt: "hi" })
    ).resolves.toMatchObject({
      text: "still usable",
    });
  });

  it("fails closed on malformed sync and async supportedUrls values", async () => {
    const sync = okModel();
    Object.defineProperty(sync, "supportedUrls", {
      value: { "image/*": ["not-a-regexp"] },
    });
    const asyncModel = okModel();
    Object.defineProperty(asyncModel, "supportedUrls", {
      value: Promise.resolve("not-a-map"),
    });
    const sparse = okModel();
    Object.defineProperty(sparse, "supportedUrls", {
      value: { "image/*": new Array(1_000_000) },
    });
    const syncRoute = createRouter({ models: { chat: [sync] } });
    const asyncRoute = createRouter({ models: { chat: [asyncModel] } });
    const sparseRoute = createRouter({ models: { chat: [sparse] } });

    expect(asV4(syncRoute("chat")).supportedUrls).toEqual({});
    await expect(asV4(asyncRoute("chat")).supportedUrls).resolves.toEqual({});
    expect(asV4(sparseRoute("chat")).supportedUrls).toEqual({});
  });

  it("consumes Promise-valued supportedUrls schema siblings", async () => {
    const model = okModel();
    Object.defineProperty(model, "supportedUrls", {
      value: Promise.resolve({
        "image/*": Promise.reject(new Error("async pattern list")),
        "video/*": [Promise.reject(new Error("async pattern entry"))],
      }),
    });
    const routed = asV4(createRouter({ models: { chat: [model] } })("chat"));

    await expect(routed.supportedUrls).resolves.toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots supportedUrls patterns against provider mutation", () => {
    const original = MUTABLE_EXAMPLE_RE;
    const patterns = [original];
    const model = okModel();
    Object.defineProperty(model, "supportedUrls", {
      value: { "image/*": patterns },
    });
    const route = createRouter({ models: { chat: [model] } });
    const supported = asV4(route("chat")).supportedUrls as Record<
      string,
      RegExp[]
    >;

    patterns.length = 0;
    original.lastIndex = 12;

    expect(supported["image/*"]).toHaveLength(1);
    expect(supported["image/*"][0]).not.toBe(original);
    expect(supported["image/*"][0].lastIndex).toBe(0);
  });

  it("isolates synchronous supportedUrls from consumer mutation", () => {
    const model = okModel();
    Object.defineProperty(model, "supportedUrls", {
      value: { "image/*": [EXAMPLE_HTTPS_RE] },
    });
    const routed = asV4(createRouter({ models: { chat: [model] } })("chat"));
    const first = routed.supportedUrls as Record<string, RegExp[]>;

    first["image/*"][0].lastIndex = 42;
    first["image/*"].length = 0;
    first["video/*"] = [EXAMPLE_HTTPS_RE];
    const second = routed.supportedUrls as Record<string, RegExp[]>;

    expect(second).toEqual({ "image/*": [EXAMPLE_HTTPS_RE] });
    expect(second).not.toBe(first);
    expect(second["image/*"]).not.toBe(first["image/*"]);
    expect(second["image/*"][0].lastIndex).toBe(0);
  });

  it("isolates asynchronous supportedUrls from consumer mutation", async () => {
    const model = okModel();
    Object.defineProperty(model, "supportedUrls", {
      value: Promise.resolve({ "image/*": [EXAMPLE_HTTPS_RE] }),
    });
    const routed = asV4(createRouter({ models: { chat: [model] } })("chat"));
    const first = await routed.supportedUrls;

    first["image/*"].length = 0;
    const second = await routed.supportedUrls;

    expect(second).toEqual({ "image/*": [EXAMPLE_HTTPS_RE] });
    expect(second).not.toBe(first);
    expect(second["image/*"]).not.toBe(first["image/*"]);
  });
});
