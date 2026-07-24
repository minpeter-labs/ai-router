import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { asV4, finishReason, genOptions, okModel, usage } from "./test-kit";

describe("createRouter — fallback", () => {
  it("reads oversized response-header keys once without reading values", async () => {
    let ownKeysReads = 0;
    let valueReads = 0;
    const target = Object.fromEntries(
      Array.from({ length: 1025 }, (_, index) => [`x-${index}`, "value"])
    );
    const headers = new Proxy(target, {
      get(object, property, receiver) {
        valueReads += 1;
        return Reflect.get(object, property, receiver);
      },
      ownKeys(object) {
        ownKeysReads += 1;
        return Reflect.ownKeys(object);
      },
    });
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [{ text: "must not leak", type: "text" }],
          finishReason,
          response: { headers },
          usage,
          warnings: [],
        } as never),
    });
    const secondary = okModel("fallback answer");
    const route = createRouter({ models: { chat: [primary, secondary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);

    expect(result.content).toMatchObject([
      { text: "fallback answer", type: "text" },
    ]);
    expect(ownKeysReads).toBe(1);
    expect(valueReads).toBe(0);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });

  it("rejects invalid generate response-header names before reading values", async () => {
    let reads = 0;
    const headers = Object.defineProperties(
      {},
      {
        "bad header": {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error("must not be read");
          },
        },
        "x-later": {
          enumerable: true,
          value: Promise.reject(new Error("async invalid-name sibling")),
        },
      }
    );
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [{ text: "must not leak", type: "text" }],
          finishReason,
          response: { headers },
          usage,
          warnings: [],
        } as never),
    });
    const route = createRouter({
      models: { chat: [primary, okModel("fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "fallback" });
    expect(reads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes generate header Promise siblings before a value getter throws", async () => {
    const headers = Object.defineProperties(
      {},
      {
        "x-first": {
          enumerable: true,
          get() {
            throw new Error("header getter failed");
          },
        },
        "x-later": {
          enumerable: true,
          value: Promise.reject(new Error("async header sibling")),
        },
      }
    );
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [{ text: "must not leak", type: "text" }],
          finishReason,
          response: { headers },
          usage,
          warnings: [],
        } as never),
    });
    const route = createRouter({
      models: { chat: [primary, okModel("fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes top-level generate Promise siblings before a getter throws", async () => {
    const result = Object.defineProperties(
      {},
      {
        content: {
          enumerable: true,
          get() {
            throw new Error("content getter failed");
          },
        },
        usage: {
          enumerable: true,
          value: Promise.reject(new Error("async usage sibling")),
        },
        warnings: {
          enumerable: true,
          value: Promise.reject(new Error("async warnings sibling")),
        },
      }
    );
    const primary = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(result as never),
    });
    const route = createRouter({
      models: { chat: [primary, okModel("fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects unknown generated file tags without reading payload fields", async () => {
    let reads = 0;
    const data = Object.defineProperties(
      {},
      {
        type: { enumerable: true, value: "unknown" },
        url: {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error("unknown payload must not be read");
          },
        },
      }
    );
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [{ data, mediaType: "image/png", type: "file" }],
          finishReason,
          usage,
          warnings: [],
        } as never),
    });
    const secondary = okModel("fallback answer");
    const route = createRouter({ models: { chat: [primary, secondary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);

    expect(result.content).toMatchObject([
      { text: "fallback answer", type: "text" },
    ]);
    expect(reads).toBe(0);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });
});
