import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { asV4, finishReason, genOptions, okModel, usage } from "./test-kit";

describe("createRouter — fallback", () => {
  it("snapshots known generated content fields without reading extensions", async () => {
    let text = "stable content";
    const reads = new Map<string, number>();
    const once = (name: string, read: () => unknown) => ({
      enumerable: true,
      get() {
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        if (count > 1) {
          throw new Error(`${name} read twice`);
        }
        return read();
      },
    });
    const part = Object.defineProperties(
      {},
      {
        providerMetadata: once("providerMetadata", () => ({ mock: {} })),
        text: once("text", () => text),
        type: once("type", () => "text"),
        unknown: {
          enumerable: true,
          get() {
            throw new Error("unknown extension must not be read");
          },
        },
      }
    );
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [part],
          finishReason,
          usage,
          warnings: [],
        }) as never,
    });
    const route = createRouter({ models: { chat: [primary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);
    text = "mutated content";

    expect(Object.fromEntries(reads)).toEqual({
      providerMetadata: 1,
      text: 1,
      type: 1,
    });
    expect(result.content).toEqual([
      {
        providerMetadata: { mock: {} },
        text: "stable content",
        type: "text",
      },
    ]);
  });

  it("falls back when generated content metadata access throws", async () => {
    const hostilePart = Object.defineProperty(
      { text: "unusable", type: "text" },
      "providerMetadata",
      {
        get() {
          throw new Error("content metadata getter failed");
        },
      }
    );
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [hostilePart],
          finishReason,
          usage,
          warnings: [],
        }) as never,
    });
    const route = createRouter({
      models: { chat: [primary, okModel("metadata fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "metadata fallback" });
  });

  it("falls back on malformed nested generate metadata", async () => {
    const hostileRequest = Object.defineProperty({}, "body", {
      get() {
        throw new Error("request body getter failed");
      },
    });
    const metadataVariants = [
      { providerMetadata: "invalid" },
      { request: hostileRequest },
      { response: { id: 42 } },
      { response: { timestamp: new Date(Number.NaN) } },
      { response: { headers: { "x-invalid": 42 } } },
      { response: { headers: { "x-invalid": "safe\r\ninjected" } } },
      {
        response: {
          headers: Object.fromEntries(
            Array.from({ length: 1025 }, (_, index) => [`x-${index}`, "value"])
          ),
        },
      },
      {
        response: {
          headers: Object.fromEntries(
            Array.from({ length: 17 }, (_, index) => [
              `x-large-${index}`,
              "x".repeat(65_536),
            ])
          ),
        },
      },
    ];

    for (const metadata of metadataVariants) {
      const primary = new MockLanguageModelV4({
        doGenerate: async () =>
          ({
            content: [{ text: "unusable", type: "text" }],
            finishReason,
            usage,
            warnings: [],
            ...metadata,
          }) as never,
      });
      const fallback = okModel("metadata recovered");
      const route = createRouter({ models: { chat: [primary, fallback] } });

      await expect(
        generateText({ model: route("chat"), prompt: "hi" })
      ).resolves.toMatchObject({ text: "metadata recovered" });
      expect(fallback.doGenerateCalls).toHaveLength(1);
    }
  });

  it("preserves and consumes Promise-valued opaque telemetry bodies", async () => {
    const body = Promise.reject(new Error("opaque request body rejected"));
    const primary = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ text: "usable", type: "text" }],
        finishReason,
        request: { body },
        usage,
        warnings: [],
      }),
    });
    const fallback = okModel("must not run");
    const route = createRouter({
      models: { chat: [primary, fallback] },
    });

    const result = await asV4(route("chat")).doGenerate(genOptions);

    expect(result.request?.body).toBe(body);
    expect(fallback.doGenerateCalls).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes every rejected top-level generate field before fallback", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: Promise.reject(new Error("async content unsupported")),
          finishReason: Promise.reject(
            new Error("async finish reason unsupported")
          ),
          usage: Promise.reject(new Error("async usage unsupported")),
          warnings: Promise.reject(new Error("async warnings unsupported")),
        }) as never,
    });
    const route = createRouter({
      models: { chat: [primary, okModel("aggregate async fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "aggregate async fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
