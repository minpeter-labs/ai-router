import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  failingModel,
  finishReason,
  genOptions,
  okModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("falls back from a failing primary to a working secondary", async () => {
    const primary = failingModel("429 rate limited");
    const secondary = okModel("fallback answer");
    const errors: unknown[] = [];

    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
      onError: ({ error }) => errors.push(error),
    });

    const { text } = await generateText({ model: route("chat"), prompt: "hi" });
    expect(text).toBe("fallback answer");
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("429 rate limited");
  });

  it("falls back when a provider returns an empty successful response", async () => {
    const empty = okModel("");
    const secondary = okModel("fallback answer");
    const route = createRouter({
      models: { chat: [empty, secondary] },
    });

    const { text } = await generateText({ model: route("chat"), prompt: "hi" });

    expect(text).toBe("fallback answer");
    expect(empty.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });

  it("snapshots generate content and warning indexes exactly once", async () => {
    const reads = { content: 0, warnings: 0 };
    const once = <T>(items: T[], key: keyof typeof reads): T[] =>
      new Proxy(items, {
        get(target, property, receiver) {
          if (property === "0") {
            reads[key] += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      });
    const content = once([{ text: "stable", type: "text" }], "content");
    const warnings = once(
      [{ details: "detail", feature: "feature", type: "unsupported" }],
      "warnings"
    );
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({ content, finishReason, usage, warnings } as never),
    });
    const route = createRouter({ models: { chat: [primary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);

    expect(reads).toEqual({ content: 1, warnings: 1 });
    expect(result.content).toEqual([
      { providerMetadata: undefined, text: "stable", type: "text" },
    ]);
    expect(result.warnings).toEqual([
      { details: "detail", feature: "feature", type: "unsupported" },
    ]);
  });

  it("falls back when a generate warning index cannot be snapshotted", async () => {
    const warnings = new Proxy([{ message: "hidden", type: "other" }], {
      get(target, property, receiver) {
        if (property === "0") {
          throw new Error("warning index failed");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [{ text: "must not leak", type: "text" }],
          finishReason,
          usage,
          warnings,
        } as never),
    });
    const secondary = okModel("fallback answer");
    const route = createRouter({ models: { chat: [primary, secondary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);

    expect(result.content).toEqual([
      {
        providerMetadata: undefined,
        text: "fallback answer",
        type: "text",
      },
    ]);
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });

  it("bounds aggregate JSON containers across generated content", async () => {
    const content = Array.from({ length: 6 }, (_, index) => ({
      providerMetadata: {
        mock: { items: Array.from({ length: 9000 }, () => ({})) },
      },
      text: `primary-${index}`,
      type: "text" as const,
    }));
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({ content, finishReason, usage, warnings: [] }),
    });
    const secondary = okModel("fallback answer");
    const route = createRouter({ models: { chat: [primary, secondary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);

    expect(result.content).toMatchObject([
      { text: "fallback answer", type: "text" },
    ]);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });

  it("bounds aggregate JSON string and key characters in generate results", async () => {
    const payload = "x".repeat(1_000_000);
    const content = Array.from({ length: 5 }, (_, index) => ({
      providerMetadata: { mock: { payload } },
      text: `primary-${index}`,
      type: "text" as const,
    }));
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({ content, finishReason, usage, warnings: [] }),
    });
    const secondary = okModel("fallback answer");
    const route = createRouter({ models: { chat: [primary, secondary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);

    expect(result.content).toMatchObject([
      { text: "fallback answer", type: "text" },
    ]);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });

  it("bounds generate metadata while leaving model body text unrestricted", async () => {
    const body = "x".repeat(100_000);
    const valid = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [{ text: body, type: "text" }],
          finishReason,
          usage,
          warnings: [],
        }),
    });
    const validRoute = createRouter({ models: { chat: [valid] } });
    await expect(
      asV4(validRoute("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({ content: [{ text: body, type: "text" }] });

    const title = "t".repeat(65_536);
    const content = Array.from({ length: 65 }, (_, index) => ({
      id: `source-${index}`,
      sourceType: "url" as const,
      title,
      type: "source" as const,
      url: "https://example.com/source",
    }));
    const excessive = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({ content, finishReason, usage, warnings: [] }),
    });
    const secondary = okModel("fallback answer");
    const route = createRouter({ models: { chat: [excessive, secondary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);

    expect(result.content).toMatchObject([
      { text: "fallback answer", type: "text" },
    ]);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });

  it("allows empty optional generated metadata strings", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [
            {
              id: "source",
              sourceType: "url",
              title: "",
              type: "source",
              url: "https://example.com/source",
            },
          ],
          finishReason: { raw: "", unified: "stop" },
          usage,
          warnings: [],
        } as never),
    });
    const route = createRouter({ models: { chat: [primary] } });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({ finishReason: { raw: "", unified: "stop" } });
  });
});
