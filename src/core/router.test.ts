import { runInNewContext } from "node:vm";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterConcurrencyError } from "./admission";
import {
  MemoryRouterHealthStore,
  RouterHealthUnavailableError,
} from "./health";
import { detectModalities } from "./modality";
import { OrderingTokenSource } from "./ordering";
import { createRouter } from "./router";
import type { Modality, RouterHealthRecord } from "./types";

// `route()` is typed as `LanguageModel` (a union that includes a bare model-id
// string). The router always returns a V4 model object; narrow it so tests can
// read model-level fields like `supportedUrls` without fighting the union.
const asV4 = (m: LanguageModel): LanguageModelV4 => m as LanguageModelV4;

// ---------------------------------------------------------------------------
// V4 result building blocks (nested usage + object finishReason). Copied from
// the existing suite verbatim so every mock returns a spec-valid shape.
// ---------------------------------------------------------------------------
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const finishReason = { unified: "stop" as const, raw: "stop" };

// Regex literals hoisted to module scope (Biome performance/useTopLevelRegex):
// allocate each matcher once rather than per assertion / per mock construction.
const NO_CANDIDATE_RE = /no candidate.*modalities/;
const NOT_V4_RE = /did not provide a v4 LanguageModel/;
const HTTPS_A_RE = /^https:\/\/a\//;
const EXAMPLE_HTTPS_RE = /^https:\/\/example\.com\/.*$/;
const MUTABLE_EXAMPLE_RE = /^https:\/\/example\.com\//;
const MAX_ATTEMPTS_RE = /maxAttempts/;

function okModel(text = "Hello, world!") {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason,
      usage,
      warnings: [],
    }),
  });
}

function failingModel(message = "simulated API failure") {
  return new MockLanguageModelV4({
    doGenerate: () => Promise.reject(new Error(message)),
  });
}

function streamingModel(parts: string[] = ["Hello", ", world!"]) {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          ...parts.map((delta) => ({
            type: "text-delta" as const,
            id: "1",
            delta,
          })),
          { type: "text-end", id: "1" },
          { type: "finish", finishReason, usage },
        ],
      }),
    }),
  });
}

function failingStreamModel(message = "simulated stream failure") {
  return new MockLanguageModelV4({
    doStream: () => Promise.reject(new Error(message)),
  });
}

// A V4 image file part (data URL, not http) so the SDK inlines it instead of
// fetching over the network — keeps every integration test hermetic.
const imagePart = {
  type: "file" as const,
  mediaType: "image/png",
  data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
};

async function collectStream(result: ReturnType<typeof streamText>) {
  let acc = "";
  for await (const chunk of result.textStream) {
    acc += chunk;
  }
  return acc;
}

async function collectRawStream(
  stream: ReadableStream<LanguageModelV4StreamPart>
): Promise<{ error?: unknown; text: string }> {
  const reader = stream.getReader();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return { text };
      }
      if (value.type === "text-delta") {
        text += value.delta;
      }
    }
  } catch (error) {
    return { error, text };
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// detectModalities
// ---------------------------------------------------------------------------
describe("detectModalities", () => {
  it("detects text from system + text parts", () => {
    const mods = detectModalities([
      { role: "system", content: "be nice" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect([...mods]).toEqual(["text"]);
  });

  it("detects image and pdf via mediaType (full, wildcard, bare, application/pdf)", () => {
    const mods = detectModalities([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "url", url: new URL("https://x/y.png") },
          },
          {
            type: "file",
            mediaType: "application/pdf",
            data: { type: "url", url: new URL("https://x/y.pdf") },
          },
        ],
      },
    ]);
    const expected: Modality[] = ["text", "image", "pdf"];
    expect([...mods].sort()).toEqual(expected.sort());
  });
});

// ---------------------------------------------------------------------------
// createRouter — routing, fallback, modality filtering, errors
// ---------------------------------------------------------------------------
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

  it("consumes rejected nested generated file payloads before fallback", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [
            {
              data: {
                data: Promise.reject(new Error("async generated file data")),
                type: "data",
              },
              mediaType: "image/png",
              type: "file",
            },
            {
              mediaType: Promise.reject(
                new Error("async generated media type sibling")
              ),
              providerMetadata: Promise.reject(
                new Error("async generated metadata sibling")
              ),
              type: Promise.reject(
                new Error("async generated content discriminant")
              ),
            },
          ],
          finishReason,
          usage,
          warnings: [],
        }) as never,
    });
    const route = createRouter({
      models: { chat: [primary, okModel("file fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "file fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots mutable generated byte and URL payloads", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const url = new URL("https://example.com/file.png");
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [
            {
              data: { data: bytes, type: "data" },
              mediaType: "image/png",
              type: "file",
            },
            {
              data: { type: "url", url },
              mediaType: "image/png",
              type: "file",
            },
          ],
          finishReason,
          usage,
          warnings: [],
        } as never),
    });
    const route = createRouter({ models: { chat: [primary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);
    const bytePart = result.content[0] as { data: { data: Uint8Array } };
    const urlPart = result.content[1] as { data: { url: URL } };
    bytes[0] = 9;
    url.pathname = "/mutated.png";

    expect(bytePart.data.data).not.toBe(bytes);
    expect([...bytePart.data.data]).toEqual([1, 2, 3]);
    expect(urlPart.data.url).not.toBe(url);
    expect(urlPart.data.url.toString()).toBe("https://example.com/file.png");
  });

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

  it("falls back when generate content properties throw", async () => {
    const hostile = Object.defineProperty(
      { finishReason, usage, warnings: [] },
      "content",
      {
        get() {
          throw new Error("content getter failed");
        },
      }
    );
    const route = createRouter({
      models: {
        chat: [
          new MockLanguageModelV4({
            doGenerate: () => Promise.resolve(hostile as never),
          }),
          okModel("valid"),
        ],
      },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "valid" }],
    });
  });

  it("reads generate envelope accessors once and snapshots result arrays", async () => {
    const content = [{ text: "stable", type: "text" as const }];
    const warnings = [{ message: "note", type: "other" as const }];
    const values = {
      content,
      finishReason,
      providerMetadata: { mock: { stable: true } },
      request: { body: "request" },
      response: { id: "response" },
      usage,
      warnings,
    };
    const reads = new Map<string, number>();
    const source = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          {
            enumerable: true,
            get() {
              const count = (reads.get(key) ?? 0) + 1;
              reads.set(key, count);
              if (count > 1) {
                throw new Error(`${key} read twice`);
              }
              return value;
            },
          },
        ])
      )
    );
    const primary = new MockLanguageModelV4({
      doGenerate: async () => source as never,
    });
    const route = createRouter({ models: { chat: [primary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);
    content.length = 0;
    warnings.length = 0;

    expect(Object.fromEntries(reads)).toEqual(
      Object.fromEntries(Object.keys(values).map((key) => [key, 1]))
    );
    expect(result.content).toEqual([{ text: "stable", type: "text" }]);
    expect(result.warnings).toEqual([{ message: "note", type: "other" }]);
  });

  it("snapshots nested finish and usage accessors once", async () => {
    const reads = new Map<string, number>();
    const once = (scope: string, values: Record<string, unknown>) =>
      Object.defineProperties(
        {},
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            {
              enumerable: true,
              get() {
                const label = `${scope}.${key}`;
                const count = (reads.get(label) ?? 0) + 1;
                reads.set(label, count);
                if (count > 1) {
                  throw new Error(`${label} read twice`);
                }
                return value;
              },
            },
          ])
        )
      );
    const inputTokens = once("input", usage.inputTokens);
    const outputTokens = once("output", usage.outputTokens);
    const nestedUsage = once("usage", {
      inputTokens,
      outputTokens,
      raw: { provider: "stable" },
    });
    const nestedFinish = once("finish", finishReason);
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [{ text: "stable", type: "text" }],
          finishReason: nestedFinish,
          usage: nestedUsage,
          warnings: [],
        }) as never,
    });
    const route = createRouter({ models: { chat: [primary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);

    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(result.finishReason).toEqual(finishReason);
    expect(result.usage).toEqual({ ...usage, raw: { provider: "stable" } });
  });

  it("snapshots nested request, response, and header accessors once", async () => {
    const reads = new Map<string, number>();
    const getter = (name: string, read: () => unknown) => ({
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
    let headerValue = "stable";
    const headers = Object.create(null);
    Object.defineProperty(
      headers,
      "__proto__",
      getter("header.__proto__", () => "literal")
    );
    Object.defineProperty(
      headers,
      "x-provider",
      getter("header.x-provider", () => headerValue)
    );
    const requestBody = { prompt: "request-body" };
    const responseBody = { id: "response-body" };
    const request = Object.defineProperties(
      {},
      {
        body: getter("request.body", () => requestBody),
      }
    );
    const timestamp = new Date(1000);
    const response = Object.defineProperties(
      {},
      {
        body: getter("response.body", () => responseBody),
        headers: getter("response.headers", () => headers),
        id: getter("response.id", () => "response-id"),
        modelId: getter("response.modelId", () => "provider-model"),
        timestamp: getter("response.timestamp", () => timestamp),
      }
    );
    const primary = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ text: "stable", type: "text" }],
        finishReason,
        request,
        response,
        usage,
        warnings: [],
      }),
    });
    const route = createRouter({ models: { chat: [primary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);
    headerValue = "mutated";
    requestBody.prompt = "mutated";
    responseBody.id = "mutated";
    timestamp.setTime(2000);

    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(result.request).toEqual({ body: { prompt: "request-body" } });
    expect(result.response).toMatchObject({
      body: { id: "response-body" },
      id: "response-id",
      modelId: "provider-model",
      timestamp: new Date(1000),
    });
    expect(result.response?.timestamp).not.toBe(timestamp);
    const copiedHeaders = result.response?.headers as Record<string, string>;
    expect(copiedHeaders["x-provider"]).toBe("stable");
    expect(Reflect.get(copiedHeaders, "__proto__")).toBe("literal");
    expect(Object.getPrototypeOf(copiedHeaders)).toBe(Object.prototype);
  });

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

  it("consumes rejected Promise generate metadata before fallback", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ text: "unusable", type: "text" }],
        finishReason,
        request: {
          body: Promise.reject(new Error("async request body unsupported")),
        },
        usage,
        warnings: [],
      }),
    });
    const route = createRouter({
      models: { chat: [primary, okModel("async metadata fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "async metadata fallback" });
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

  it("consumes every rejected nested usage field before fallback", async () => {
    let thenReads = 0;
    const arbitraryThenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        return () => undefined;
      },
    });
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [{ text: "unusable", type: "text" }],
          finishReason,
          usage: {
            inputTokens: {
              cacheRead: Promise.reject(new Error("async cache read")),
              cacheWrite: Promise.reject(new Error("async cache write")),
              noCache: arbitraryThenable,
              total: 10,
            },
            outputTokens: {
              reasoning: Promise.reject(new Error("async reasoning tokens")),
              text: Promise.reject(new Error("async text tokens")),
              total: 20,
            },
            raw: {
              first: Promise.reject(new Error("async raw usage first")),
              second: Promise.reject(new Error("async raw usage second")),
            },
          },
          warnings: [],
        }) as never,
    });
    const route = createRouter({
      models: { chat: [primary, okModel("nested async fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "nested async fallback" });
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected nested fields across generate metadata branches", async () => {
    const rejected = (label: string) => Promise.reject(new Error(label));
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [
            {
              providerMetadata: rejected("async content metadata"),
              text: rejected("async content text"),
              type: "text",
            },
            rejected("async content part"),
          ],
          finishReason,
          response: {
            headers: {
              "x-first": rejected("async first header"),
              "x-second": rejected("async second header"),
            },
          },
          usage,
          warnings: [
            {
              details: rejected("async warning details"),
              feature: rejected("async warning feature"),
              type: "unsupported",
            },
            rejected("async warning entry"),
          ],
        }) as never,
    });
    const route = createRouter({
      models: { chat: [primary, okModel("nested branch fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "nested branch fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected Promises nested across generate JSON branches", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [{ text: "unusable", type: "text" }],
          finishReason,
          providerMetadata: {
            mock: {
              first: Promise.reject(new Error("async provider JSON first")),
              second: Promise.reject(new Error("async provider JSON second")),
            },
          },
          request: {
            body: {
              nested: Promise.reject(new Error("async request JSON")),
            },
          },
          response: {
            body: {
              nested: Promise.reject(new Error("async response JSON")),
            },
            headers: {
              "x-first": Promise.reject(new Error("async response header one")),
              "x-second": Promise.reject(
                new Error("async response header two")
              ),
            },
          },
          usage: {
            ...usage,
            raw: {
              nested: Promise.reject(new Error("async usage JSON")),
            },
          },
          warnings: [],
        }) as never,
    });
    const route = createRouter({
      models: { chat: [primary, okModel("nested JSON fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "nested JSON fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected nested branches within one generated content part", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [
            {
              providerMetadata: {
                mock: Promise.reject(new Error("async part metadata JSON")),
              },
              result: {
                first: Promise.reject(new Error("async tool result first")),
                second: Promise.reject(new Error("async tool result second")),
              },
              toolCallId: "call",
              toolName: "tool",
              type: "tool-result",
            },
          ],
          finishReason,
          usage,
          warnings: [],
        }) as never,
    });
    const route = createRouter({
      models: { chat: [primary, okModel("content branch fallback")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "content branch fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("falls back on cyclic provider JSON payloads", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const variants = [
      { providerMetadata: { mock: circular } },
      { usage: { ...usage, raw: circular } },
      {
        content: [
          {
            result: circular,
            toolCallId: "call",
            toolName: "tool",
            type: "tool-result",
          },
        ],
      },
    ];

    for (const variant of variants) {
      const primary = new MockLanguageModelV4({
        doGenerate: async () =>
          ({
            content: [{ text: "unusable", type: "text" }],
            finishReason,
            usage,
            warnings: [],
            ...variant,
          }) as never,
      });
      const fallback = okModel("json fallback");
      const route = createRouter({ models: { chat: [primary, fallback] } });

      await expect(
        generateText({ model: route("chat"), prompt: "hi" })
      ).resolves.toMatchObject({ text: "json fallback" });
    }
  });

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

  it("consumes rejected nested mutations on discarded validator input", async () => {
    const route = createRouter({
      fallback: {
        validateResult: (result) => {
          const content = result.content[0] as unknown as Record<
            string,
            unknown
          >;
          content.text = Promise.reject(new Error("async content text"));
          content.type = Promise.reject(new Error("async content type"));
          const finish = result.finishReason as unknown as Record<
            string,
            unknown
          >;
          finish.raw = Promise.reject(new Error("async finish raw"));
          finish.unified = Promise.reject(new Error("async finish unified"));
          result.warnings.push({
            message: Promise.reject(new Error("async warning message")),
            type: Promise.reject(new Error("async warning type")),
          } as never);
          const mutable = result as unknown as Record<string, unknown>;
          mutable.request = {
            body: Promise.reject(new Error("async request body")),
          };
          mutable.response = {
            id: Promise.reject(new Error("async response id")),
            timestamp: Promise.reject(new Error("async response timestamp")),
          };
          const usage = result.usage as unknown as Record<string, unknown>;
          usage.raw = Promise.reject(new Error("async usage raw"));
          const input = usage.inputTokens as Record<string, unknown>;
          input.total = Promise.reject(new Error("async input total"));
          const output = usage.outputTokens as Record<string, unknown>;
          output.total = Promise.reject(new Error("async output total"));
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

  it("consumes rejected mutations on pre-captured validator JSON fields", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            providerMetadata: { mock: { nested: { value: "content" } } },
            text: "stable",
            type: "text" as const,
          },
        ],
        finishReason,
        providerMetadata: { mock: { nested: { value: "root" } } },
        response: { body: { nested: { value: "response" } } },
        usage: { ...usage, raw: { nested: { value: "usage" } } },
        warnings: [],
      }),
    });
    const route = createRouter({
      fallback: {
        validateResult: (result) => {
          const root = result.providerMetadata?.mock as {
            nested: { value: unknown };
          };
          root.nested.value = Promise.reject(new Error("async root JSON"));
          const part = result.content[0] as unknown as {
            providerMetadata: { mock: { nested: { value: unknown } } };
          };
          part.providerMetadata.mock.nested.value = Promise.reject(
            new Error("async content JSON")
          );
          const responseBody = result.response?.body as {
            nested: { value: unknown };
          };
          responseBody.nested.value = Promise.reject(
            new Error("async response JSON")
          );
          const raw = result.usage.raw as { nested: { value: unknown } };
          raw.nested.value = Promise.reject(new Error("async usage JSON"));
          return true;
        },
      },
      models: { chat: [model] },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "stable" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("treats malformed or throwing validateResult hooks as terminal request errors", async () => {
    for (const validateResult of [
      (() => undefined) as never,
      (() => Promise.resolve(true)) as never,
      (() => Promise.reject(new Error("async validator rejected"))) as never,
      (() => {
        throw new Error("validator bug");
      }) as never,
    ]) {
      const secondary = okModel("must not run");
      const route = createRouter({
        fallback: { validateResult },
        models: { chat: [okModel("primary"), secondary] },
      });

      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).rejects.toMatchObject({
        code: "validator_contract_error",
      });
      expect(secondary.doGenerateCalls).toHaveLength(0);
    }

    let thenReads = 0;
    const thenExtendedResult = Object.defineProperty(
      {},
      ["th", "en"].join(""),
      {
        get() {
          thenReads += 1;
          throw new Error("arbitrary then getter must not be read");
        },
      }
    );
    const route = createRouter({
      fallback: { validateResult: (() => thenExtendedResult) as never },
      models: { chat: [okModel("primary"), okModel("must not run")] },
    });
    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).rejects.toMatchObject({ code: "validator_contract_error" });
    expect(thenReads).toBe(0);
  });

  it("does not train provider state or fan out after a validator contract throw", async () => {
    let validations = 0;
    const primary = okModel("valid provider result");
    const fallback = okModel("must not run");
    const route = createRouter({
      fallback: {
        health: true,
        retryBudget: true,
        validateResult: () => {
          validations += 1;
          if (validations === 1) {
            return true;
          }
          throw new Error("validator implementation failed");
        },
      },
      models: {
        chat: [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: primary,
          },
          fallback,
        ],
      },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "valid" })
    ).resolves.toMatchObject({
      text: "valid provider result",
    });
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      inFlight: 0,
      successes: 1,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    await expect(
      generateText({ model: route("chat"), prompt: "broken validator" })
    ).rejects.toMatchObject({
      code: "validator_contract_error",
    });
    expect(fallback.doGenerateCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 1,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
  });

  it("falls back when a provider exceeds attemptTimeout", async () => {
    const hanging = new MockLanguageModelV4({
      doGenerate: () => new Promise(() => undefined),
    });
    const secondary = okModel("after timeout");
    const route = createRouter({
      fallback: { attemptTimeout: 5 },
      models: { chat: [hanging, secondary] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "after timeout" });
  });

  it("consumes rejected fields in a generate result that resolves after timeout", async () => {
    let resolveLate:
      | ((result: LanguageModelV4GenerateResult) => void)
      | undefined;
    const hanging = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise<LanguageModelV4GenerateResult>((resolve) => {
          resolveLate = resolve;
        }),
    });
    const route = createRouter({
      fallback: { attemptTimeout: 5 },
      models: { chat: [hanging, okModel("after timeout")] },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "after timeout" }],
    });
    resolveLate?.({
      get content(): never {
        throw new Error("late content unavailable");
      },
      finishReason: { raw: "stop", unified: "stop" },
      providerMetadata: {
        mock: Array.from({ length: 50_000 }, () => ({})),
      },
      request: {
        body: {
          prompt: Promise.reject(new Error("late generate field rejected")),
        },
      },
      usage,
      warnings: [],
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("cancels a provider stream that opens after its attempt timed out", async () => {
    let resolveOpen:
      | ((result: LanguageModelV4StreamResult) => void)
      | undefined;
    let cancelled = false;
    const hanging = new MockLanguageModelV4({
      doStream: () =>
        new Promise<LanguageModelV4StreamResult>((resolve) => {
          resolveOpen = resolve;
        }),
    });
    const route = createRouter({
      fallback: { attemptTimeout: 5 },
      models: { chat: [hanging, streamingModel(["after timeout"])] },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("after timeout");

    resolveOpen?.({
      stream: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("cancels a late stream opened by a timed-out mid-stream fallback", async () => {
    let resolveOpen:
      | ((result: LanguageModelV4StreamResult) => void)
      | undefined;
    let cancelled = false;
    const hangingFallback = new MockLanguageModelV4({
      doStream: () =>
        new Promise<LanguageModelV4StreamResult>((resolve) => {
          resolveOpen = resolve;
        }),
    });
    const route = createRouter({
      fallback: { attemptTimeout: 5 },
      models: {
        chat: [
          failingStreamModel("first failed"),
          hangingFallback,
          streamingModel(["third survived"]),
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("third survived");

    resolveOpen?.({
      stream: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("censors a total-timeout fallback open and cancels its late stream", async () => {
    let resolveOpen:
      | ((result: LanguageModelV4StreamResult) => void)
      | undefined;
    let cancelled = false;
    const secondary = new MockLanguageModelV4({
      doStream: () =>
        new Promise<LanguageModelV4StreamResult>((resolve) => {
          resolveOpen = resolve;
        }),
    });
    const tertiary = streamingModel(["must not open"]);
    const route = createRouter({
      fallback: {
        health: true,
        retryBudget: true,
        totalTimeout: 20,
      },
      models: {
        chat: [
          errorPartStreamModel(new Error("primary stream failed")),
          {
            adaptiveConcurrency: { initial: 2, max: 4, min: 1 },
            model: secondary,
          },
          tertiary,
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).rejects.toMatchObject({ code: "total_timeout" });

    expect(tertiary.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([
      expect.objectContaining({
        key: expect.stringContaining(":unit:0"),
        record: expect.objectContaining({ failures: 1 }),
      }),
    ]);
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });

    resolveOpen?.({
      stream: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("censors an aborted fallback open and cancels its late stream", async () => {
    let resolveOpen:
      | ((result: LanguageModelV4StreamResult) => void)
      | undefined;
    let cancelled = false;
    const secondary = new MockLanguageModelV4({
      doStream: () =>
        new Promise<LanguageModelV4StreamResult>((resolve) => {
          resolveOpen = resolve;
        }),
    });
    const tertiary = streamingModel(["must not open"]);
    const route = createRouter({
      fallback: { health: true, retryBudget: true },
      models: {
        chat: [
          errorPartStreamModel(new Error("primary stream failed")),
          {
            adaptiveConcurrency: { initial: 2, max: 4, min: 1 },
            model: secondary,
          },
          tertiary,
        ],
      },
    });
    const controller = new AbortController();
    const result = await asV4(route("chat")).doStream({
      ...genOptions,
      abortSignal: controller.signal,
    });
    const reader = result.stream.getReader();
    const pending = (async () => {
      while (!(await reader.read()).done) {
        // Drain until the fallback opening settles or fails.
      }
    })();
    while (secondary.doStreamCalls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const reason = new Error("caller stopped fallback opening");

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(tertiary.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([
      expect.objectContaining({
        key: expect.stringContaining(":unit:0"),
        record: expect.objectContaining({ failures: 1 }),
      }),
    ]);
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });

    resolveOpen?.({
      stream: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("removes a fallback admission waiter when the total deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const held = new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "held" });
              controller.enqueue({
                type: "text-delta",
                id: "held",
                delta: "held",
              });
            },
          }),
        }),
      });
      const primary = new MockLanguageModelV4({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({
                  error: new Error("primary stream failed"),
                  type: "error",
                });
                controller.close();
              },
            }),
          }),
      });
      const fallback = streamingModel(["must not open"]);
      const attempts: Array<{
        attempt?: number;
        index: number;
        outcome: string;
        reason?: string;
      }> = [];
      const route = createRouter({
        fallback: {
          concurrencyWaitTimeout: 1000,
          health: true,
          retryBudget: true,
          totalTimeout: 200,
        },
        models: {
          hold: [
            {
              healthKey: "shared-wait-timeout",
              maxConcurrency: 1,
              model: held,
            },
          ],
          chat: [
            primary,
            {
              healthKey: "shared-wait-timeout",
              maxConcurrency: 1,
              model: fallback,
            },
          ],
        },
        onAttempt: ({ attempt, index, outcome, reason }) =>
          attempts.push({ attempt, index, outcome, reason }),
      });
      const heldResult = await asV4(route("hold")).doStream(genOptions);
      const heldReader = heldResult.stream.getReader();
      for (let reads = 0; reads < 3; reads++) {
        await heldReader.read();
      }
      expect(route.getAdmissionSnapshot("hold")[0].inFlight).toBe(1);
      const result = await asV4(route("chat")).doStream(genOptions);
      const reader = result.stream.getReader();
      const pending = (async () => {
        while (!(await reader.read()).done) {
          // Drain until admission waiting reaches the total deadline.
        }
      })();
      const pendingExpectation = expect(pending).rejects.toMatchObject({
        code: "total_timeout",
      });
      for (
        let turns = 0;
        turns < 20 && route.getAdmissionSnapshot("chat")[1].waiting === 0;
        turns++
      ) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      }
      expect(route.getAdmissionSnapshot("chat")[1].waiting).toBe(1);
      await vi.advanceTimersByTimeAsync(200);

      await pendingExpectation;
      expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
        inFlight: 1,
        waiting: 0,
      });
      expect(fallback.doStreamCalls).toHaveLength(0);
      expect(route.getHealthSnapshot("chat")).toEqual([
        expect.objectContaining({
          key: expect.stringContaining(":unit:0"),
          record: expect.objectContaining({ failures: 1 }),
        }),
      ]);
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 0,
      });
      expect(attempts).toEqual([
        {
          attempt: 1,
          index: 0,
          outcome: "failure",
          reason: undefined,
        },
      ]);

      await heldReader.cancel("release held capacity");
      await vi.advanceTimersByTimeAsync(0);
      expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
        inFlight: 0,
        waiting: 0,
      });
      expect(fallback.doStreamCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("censors caller abort while waiting for fallback stream admission", async () => {
    const held = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "held" });
            controller.enqueue({
              type: "text-delta",
              id: "held",
              delta: "held",
            });
          },
        }),
      }),
    });
    const fallback = streamingModel(["must not open"]);
    const attempts: Array<{
      attempt?: number;
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const route = createRouter({
      fallback: {
        concurrencyWaitTimeout: 1000,
        health: true,
        retryBudget: true,
      },
      models: {
        hold: [
          {
            healthKey: "shared-wait-abort",
            maxConcurrency: 1,
            model: held,
          },
        ],
        chat: [
          errorPartStreamModel(new Error("primary stream failed")),
          {
            healthKey: "shared-wait-abort",
            maxConcurrency: 1,
            model: fallback,
          },
        ],
      },
      onAttempt: ({ attempt, index, outcome, reason }) =>
        attempts.push({ attempt, index, outcome, reason }),
    });
    const heldResult = await asV4(route("hold")).doStream(genOptions);
    const heldReader = heldResult.stream.getReader();
    for (let reads = 0; reads < 3; reads++) {
      await heldReader.read();
    }
    const controller = new AbortController();
    const result = await asV4(route("chat")).doStream({
      ...genOptions,
      abortSignal: controller.signal,
    });
    const reader = result.stream.getReader();
    const pending = (async () => {
      while (!(await reader.read()).done) {
        // Drain until caller cancellation interrupts admission waiting.
      }
    })();
    const reason = new Error("caller stopped admission wait");
    const pendingExpectation = expect(pending).rejects.toBe(reason);
    await vi.waitFor(() =>
      expect(route.getAdmissionSnapshot("chat")[1].waiting).toBe(1)
    );

    controller.abort(reason);

    await pendingExpectation;
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 1,
      waiting: 0,
    });
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([
      expect.objectContaining({
        key: expect.stringContaining(":unit:0"),
        record: expect.objectContaining({ failures: 1 }),
      }),
    ]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
    expect(attempts).toEqual([
      {
        attempt: 1,
        index: 0,
        outcome: "failure",
        reason: undefined,
      },
    ]);

    await heldReader.cancel("release held capacity");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      waiting: 0,
    });
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it("reports consumer cancel while waiting for routed fallback admission", async () => {
    const held = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "held" });
              controller.enqueue({
                type: "text-delta",
                id: "held",
                delta: "held",
              });
            },
          }),
        }),
    });
    const fallback = streamingModel(["must not open"]);
    const attempts: Array<{
      attempt?: number;
      inFlight?: number;
      index: number;
      limit?: number;
      outcome: string;
    }> = [];
    const route = createRouter({
      fallback: {
        concurrencyWaitTimeout: 1000,
        health: true,
        retryBudget: true,
      },
      models: {
        hold: [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 1,
              max: 2,
              min: 1,
            },
            healthKey: "shared-wait-consumer-cancel",
            model: held,
          },
        ],
        chat: [
          errorPartStreamModel(new Error("primary stream failed")),
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 1,
              max: 2,
              min: 1,
            },
            healthKey: "shared-wait-consumer-cancel",
            model: fallback,
          },
        ],
      },
      onAttempt: ({ attempt, concurrencyLimit, inFlight, index, outcome }) =>
        attempts.push({
          attempt,
          inFlight,
          index,
          limit: concurrencyLimit,
          outcome,
        }),
    });
    const heldResult = await asV4(route("hold")).doStream(genOptions);
    const heldReader = heldResult.stream.getReader();
    for (let reads = 0; reads < 3; reads++) {
      await heldReader.read();
    }
    const caller = new AbortController();
    const result = await asV4(route("chat")).doStream({
      ...genOptions,
      abortSignal: caller.signal,
    });
    const reader = result.stream.getReader();
    const pendingRead = reader.read();
    await vi.waitFor(() =>
      expect(route.getAdmissionSnapshot("chat")[1].waiting).toBe(1)
    );

    await reader.cancel("consumer stopped routed admission wait");
    caller.abort(new Error("late caller abort after consumer cancel"));
    await pendingRead;
    await vi.waitFor(() => expect(attempts).toHaveLength(2));

    expect(attempts).toEqual([
      {
        attempt: 1,
        inFlight: 1,
        index: 0,
        limit: undefined,
        outcome: "failure",
      },
      {
        attempt: undefined,
        inFlight: 1,
        index: 1,
        limit: 1,
        outcome: "cancelled",
      },
    ]);
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      adaptive: true,
      inFlight: 1,
      limit: 1,
      successes: 0,
      waiting: 0,
    });
    expect(route.getHealthSnapshot("chat")).toEqual([
      expect.objectContaining({
        key: expect.stringContaining(":unit:0"),
        record: expect.objectContaining({ failures: 1 }),
      }),
    ]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
    expect(fallback.doStreamCalls).toHaveLength(0);

    await heldReader.cancel("release held capacity");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      adaptive: true,
      inFlight: 0,
      limit: 1,
      successes: 0,
      waiting: 0,
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "retry" }))
    ).resolves.toBe("must not open");
    expect(fallback.doStreamCalls).toHaveLength(1);
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      adaptive: true,
      inFlight: 0,
      limit: 1,
      successes: 1,
      waiting: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
  });

  it("does not accumulate waiter or AIMD feedback across repeated cancel-retry cycles", async () => {
    const held = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "held" });
              controller.enqueue({
                type: "text-delta",
                id: "held",
                delta: "held",
              });
            },
          }),
        }),
    });
    const primary = errorPartStreamModel(new Error("primary stream failed"));
    const fallback = streamingModel(["recovered"]);
    const cancelled: Array<{ attempt?: number; index: number }> = [];
    const allCancelled: Array<{
      attempt?: number;
      index: number;
      logicalId: string;
    }> = [];
    const adaptiveConcurrency = {
      increaseAfterSuccesses: 2,
      initial: 1,
      max: 2,
      min: 1,
    };
    const route = createRouter({
      fallback: { concurrencyWaitTimeout: 1000, retryBudget: true },
      models: {
        hold: [
          {
            adaptiveConcurrency,
            healthKey: "repeated-cancel-capacity",
            model: held,
          },
        ],
        chat: [
          primary,
          {
            adaptiveConcurrency,
            healthKey: "repeated-cancel-capacity",
            model: fallback,
          },
        ],
      },
      onAttempt: ({ attempt, index, logicalId, outcome }) => {
        if (outcome === "cancelled") {
          allCancelled.push({ attempt, index, logicalId });
          if (logicalId === "chat") {
            cancelled.push({ attempt, index });
          }
        }
      },
    });

    for (let cycle = 0; cycle < 2; cycle++) {
      const heldResult = await asV4(route("hold")).doStream(genOptions);
      const heldReader = heldResult.stream.getReader();
      for (let reads = 0; reads < 3; reads++) {
        await heldReader.read();
      }
      const cancelledResult = await asV4(route("chat")).doStream(genOptions);
      const cancelledReader = cancelledResult.stream.getReader();
      const pendingRead = cancelledReader.read();
      await vi.waitFor(() =>
        expect(route.getAdmissionSnapshot("chat")[1].waiting).toBe(1)
      );

      await cancelledReader.cancel(`cancel cycle ${cycle}`);
      await pendingRead;
      await vi.waitFor(() => expect(cancelled).toHaveLength(cycle + 1));
      expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
        inFlight: 1,
        limit: 1,
        successes: cycle,
        waiting: 0,
      });

      await heldReader.cancel(`release cycle ${cycle}`);
      await expect(
        collectStream(
          streamText({ model: route("chat"), prompt: `retry ${cycle}` })
        )
      ).resolves.toBe("recovered");
    }

    expect(cancelled).toEqual([
      { attempt: undefined, index: 1 },
      { attempt: undefined, index: 1 },
    ]);
    expect(allCancelled).toEqual([
      { attempt: undefined, index: 1, logicalId: "chat" },
      { attempt: 1, index: 0, logicalId: "hold" },
      { attempt: undefined, index: 1, logicalId: "chat" },
      { attempt: 1, index: 0, logicalId: "hold" },
    ]);
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
      waiting: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 2,
    });
  });

  it.each([
    "total deadline",
    "caller abort",
  ] as const)("censors %s while waiting for generate fallback admission", async (mode) => {
    const held = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "held" });
            controller.enqueue({
              type: "text-delta",
              id: "held",
              delta: "held",
            });
          },
        }),
      }),
    });
    const fallback = okModel("must not run");
    const sharedKey = `shared-generate-wait-${mode}`;
    const route = createRouter({
      fallback: {
        concurrencyWaitTimeout: 1000,
        health: true,
        retryBudget: true,
        ...(mode === "total deadline" ? { totalTimeout: 200 } : {}),
      },
      models: {
        hold: [
          {
            healthKey: sharedKey,
            maxConcurrency: 1,
            model: held,
          },
        ],
        chat: [
          failingModel("primary generate failed"),
          {
            healthKey: sharedKey,
            maxConcurrency: 1,
            model: fallback,
          },
        ],
      },
    });
    const heldResult = await asV4(route("hold")).doStream(genOptions);
    const heldReader = heldResult.stream.getReader();
    for (let reads = 0; reads < 3; reads++) {
      await heldReader.read();
    }
    const controller = new AbortController();
    const reason = new Error("caller stopped generate admission wait");
    const pending = asV4(route("chat")).doGenerate({
      ...genOptions,
      ...(mode === "caller abort" ? { abortSignal: controller.signal } : {}),
    });
    const pendingExpectation =
      mode === "caller abort"
        ? expect(pending).rejects.toBe(reason)
        : expect(pending).rejects.toMatchObject({ code: "total_timeout" });
    await vi.waitFor(() =>
      expect(route.getAdmissionSnapshot("chat")[1].waiting).toBe(1)
    );

    if (mode === "caller abort") {
      controller.abort(reason);
    }

    await pendingExpectation;
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 1,
      waiting: 0,
    });
    expect(fallback.doGenerateCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([
      expect.objectContaining({
        key: expect.stringContaining(":unit:0"),
        record: expect.objectContaining({ failures: 1 }),
      }),
    ]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });

    await heldReader.cancel("release held capacity");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      waiting: 0,
    });
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it("enforces the total fallback opening budget", async () => {
    const hanging = new MockLanguageModelV4({
      doGenerate: () => new Promise(() => undefined),
    });
    const secondary = okModel("too late");
    const route = createRouter({
      fallback: { attemptTimeout: 100, totalTimeout: 5 },
      models: { chat: [hanging, secondary] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).rejects.toMatchObject({ code: "total_timeout" });
    expect(secondary.doGenerateCalls).toHaveLength(0);
  });

  it("keeps total fallback timing stable across wall-clock jumps", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(100_000));
      const jumpingFailure = (wallClock: number) =>
        new MockLanguageModelV4({
          doGenerate: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            vi.setSystemTime(new Date(wallClock));
            throw new Error("retry after clock jump");
          },
        });

      const forwardDurations: number[] = [];
      const forwardRoute = createRouter({
        fallback: { totalTimeout: 100 },
        models: {
          chat: [jumpingFailure(1_000_000_000), okModel("forward survived")],
        },
        onAttempt: ({ durationMs }) => forwardDurations.push(durationMs),
      });
      const forward = asV4(forwardRoute("chat")).doGenerate(genOptions);
      await vi.advanceTimersByTimeAsync(10);
      await expect(forward).resolves.toMatchObject({
        content: [{ text: "forward survived", type: "text" }],
      });
      expect(forwardDurations.every((duration) => duration <= 100)).toBe(true);

      vi.setSystemTime(new Date(100_000));
      const hanging = new MockLanguageModelV4({
        doGenerate: () => new Promise<never>(() => undefined),
      });
      const rollbackRoute = createRouter({
        fallback: { totalTimeout: 100 },
        models: { chat: [jumpingFailure(0), hanging] },
      });
      const rollback = asV4(rollbackRoute("chat")).doGenerate(genOptions);
      const rollbackExpectation = expect(rollback).rejects.toMatchObject({
        code: "total_timeout",
      });
      await vi.advanceTimersByTimeAsync(100);
      await rollbackExpectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds retry backoff by the remaining total timeout", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      const route = createRouter({
        fallback: { backoff: 10_000, totalTimeout: 50 },
        models: { chat: [failingModel("retry"), okModel("recovered")] },
      });
      const result = asV4(route("chat")).doGenerate(genOptions);
      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toMatchObject({
        content: [{ type: "text", text: "recovered" }],
      });
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("bounds stream fallback backoff by the remaining total timeout", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      const fallback = streamingModel(["stream recovered"]);
      const route = createRouter({
        fallback: { backoff: 10_000, totalTimeout: 50 },
        models: {
          chat: [errorPartStreamModel(new Error("retry")), fallback],
        },
      });
      const result = collectStream(
        streamText({ model: route("chat"), prompt: "hi" })
      );
      await vi.runAllTimersAsync();

      await expect(result).resolves.toBe("stream recovered");
      expect(fallback.doStreamCalls).toHaveLength(1);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("falls back when a stream produces no content before the deadline", async () => {
    let cancelled = false;
    const hanging = new MockLanguageModelV4({
      doStream: () => ({
        stream: new ReadableStream<never>({
          cancel() {
            cancelled = true;
          },
        }),
      }),
    });
    const fallback = streamingModel(["after timeout"]);
    const route = createRouter({
      fallback: {
        firstContentTimeout: 50,
        health: true,
        retryBudget: true,
      },
      models: {
        chat: [
          {
            adaptiveConcurrency: {
              initial: 2,
              max: 4,
              min: 1,
            },
            model: hanging,
          },
          fallback,
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("after timeout");
    expect(cancelled).toBe(true);
    expect(fallback.doStreamCalls).toHaveLength(1);
    expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(1);
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
  });

  it("lets caller abort win before first-content timeout", async () => {
    vi.useFakeTimers();
    try {
      const cancelReasons: unknown[] = [];
      const hanging = new MockLanguageModelV4({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              cancel(reason) {
                cancelReasons.push(reason);
              },
            }),
          }),
      });
      const fallback = streamingModel(["must not run"]);
      const attempts: Array<{ outcome: string }> = [];
      const route = createRouter({
        fallback: {
          firstContentTimeout: 50,
          health: true,
          retryBudget: true,
        },
        models: { chat: [hanging, fallback] },
        onAttempt: ({ outcome }) => attempts.push({ outcome }),
      });
      const caller = new AbortController();
      const reason = new Error("caller won first-content race");
      const result = await asV4(route("chat")).doStream({
        ...genOptions,
        abortSignal: caller.signal,
      });
      const reader = result.stream.getReader();
      const pending = reader.read();

      await vi.advanceTimersByTimeAsync(49);
      caller.abort(reason);

      await expect(pending).rejects.toBe(reason);
      expect(cancelReasons).toEqual([reason]);
      expect(fallback.doStreamCalls).toHaveLength(0);
      expect(attempts).toEqual([]);
      expect(route.getHealthSnapshot("chat")).toEqual([]);
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 0,
      });
      expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps first-content timeout settled before a later caller abort", async () => {
    vi.useFakeTimers();
    try {
      const hanging = new MockLanguageModelV4({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>(),
          }),
      });
      const fallback = streamingModel(["timeout fallback"]);
      const attempts: Array<{ outcome: string }> = [];
      const route = createRouter({
        fallback: {
          firstContentTimeout: 50,
          health: true,
          retryBudget: true,
        },
        models: { chat: [hanging, fallback] },
        onAttempt: ({ outcome }) => attempts.push({ outcome }),
      });
      const caller = new AbortController();
      const output = collectStream(
        streamText({
          abortSignal: caller.signal,
          model: route("chat"),
          prompt: "timeout first",
        })
      );

      await vi.advanceTimersByTimeAsync(50);
      await vi.runAllTimersAsync();
      await expect(output).resolves.toBe("timeout fallback");
      caller.abort(new Error("late caller abort"));

      expect(fallback.doStreamCalls).toHaveLength(1);
      expect(attempts.map(({ outcome }) => outcome)).toEqual([
        "failure",
        "success",
      ]);
      expect(route.getHealthSnapshot("chat")).toHaveLength(1);
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 1,
      });
      expect(
        route
          .getAdmissionSnapshot("chat")
          .every(({ inFlight }) => inFlight === 0)
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses abort-first ordering for equal first-content timer deadlines", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const reason = new Error("equal-deadline abort registered first");
      setTimeout(() => caller.abort(reason), 50);
      const hanging = new MockLanguageModelV4({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>(),
          }),
      });
      const fallback = streamingModel(["must not run"]);
      const attempts: Array<{ outcome: string }> = [];
      const route = createRouter({
        fallback: {
          firstContentTimeout: 50,
          health: true,
          retryBudget: true,
        },
        models: { chat: [hanging, fallback] },
        onAttempt: ({ outcome }) => attempts.push({ outcome }),
      });
      const result = await asV4(route("chat")).doStream({
        ...genOptions,
        abortSignal: caller.signal,
      });
      const pending = result.stream.getReader().read();
      const pendingExpectation = expect(pending).rejects.toBe(reason);

      await vi.advanceTimersByTimeAsync(50);

      await pendingExpectation;
      expect(fallback.doStreamCalls).toHaveLength(0);
      expect(attempts).toEqual([]);
      expect(route.getHealthSnapshot("chat")).toEqual([]);
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses timeout-first candidate feedback at an equal abort deadline", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const reason = new Error("equal-deadline abort registered second");
      const hanging = new MockLanguageModelV4({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>(),
          }),
      });
      const fallback = new MockLanguageModelV4({
        doStream: () => new Promise<never>(() => undefined),
      });
      const attempts: Array<{ outcome: string }> = [];
      const route = createRouter({
        fallback: {
          firstContentTimeout: 50,
          health: true,
          retryBudget: true,
        },
        models: { chat: [hanging, fallback] },
        onAttempt: ({ outcome }) => attempts.push({ outcome }),
      });
      const result = await asV4(route("chat")).doStream({
        ...genOptions,
        abortSignal: caller.signal,
      });
      const pending = result.stream.getReader().read();
      const pendingExpectation = expect(pending).rejects.toBe(reason);
      await Promise.resolve();
      setTimeout(() => caller.abort(reason), 50);

      await vi.advanceTimersByTimeAsync(50);

      await pendingExpectation;
      expect(fallback.doStreamCalls).toHaveLength(1);
      expect(attempts).toEqual([{ outcome: "failure" }]);
      expect(route.getHealthSnapshot("chat")).toHaveLength(1);
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 0,
      });
      expect(
        route
          .getAdmissionSnapshot("chat")
          .every(({ inFlight }) => inFlight === 0)
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses consumer-cancel-first ordering at an equal content deadline", async () => {
    vi.useFakeTimers();
    try {
      const reason = new Error("equal-deadline consumer cancel first");
      let reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>;
      let cancellation: Promise<void> | undefined;
      setTimeout(() => {
        cancellation = reader.cancel(reason);
      }, 50);
      const upstreamReasons: unknown[] = [];
      const hanging = new MockLanguageModelV4({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              cancel(cancelReason) {
                upstreamReasons.push(cancelReason);
              },
            }),
          }),
      });
      const fallback = streamingModel(["must not run"]);
      const attempts: Array<{ outcome: string }> = [];
      const route = createRouter({
        fallback: {
          firstContentTimeout: 50,
          health: true,
          retryBudget: true,
        },
        models: { chat: [hanging, fallback] },
        onAttempt: ({ outcome }) => attempts.push({ outcome }),
      });
      const result = await asV4(route("chat")).doStream(genOptions);
      reader = result.stream.getReader();
      const pending = reader.read();

      await vi.advanceTimersByTimeAsync(50);
      await cancellation;
      await pending;

      expect(upstreamReasons).toEqual([reason]);
      expect(fallback.doStreamCalls).toHaveLength(0);
      expect(attempts).toEqual([{ outcome: "cancelled" }]);
      expect(route.getHealthSnapshot("chat")).toEqual([]);
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 0,
      });
      expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records timeout then cancel at an equal content deadline", async () => {
    vi.useFakeTimers();
    try {
      const reason = new Error("equal-deadline consumer cancel second");
      const hanging = new MockLanguageModelV4({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>(),
          }),
      });
      const fallback = new MockLanguageModelV4({
        doStream: () => new Promise<never>(() => undefined),
      });
      const attempts: Array<{
        attempt?: number;
        index: number;
        outcome: string;
      }> = [];
      const route = createRouter({
        fallback: {
          firstContentTimeout: 50,
          health: true,
          retryBudget: true,
        },
        models: { chat: [hanging, fallback] },
        onAttempt: ({ attempt, index, outcome }) =>
          attempts.push({ attempt, index, outcome }),
      });
      const result = await asV4(route("chat")).doStream(genOptions);
      const reader = result.stream.getReader();
      const pending = reader.read();
      await Promise.resolve();
      let cancellation: Promise<void> | undefined;
      setTimeout(() => {
        cancellation = reader.cancel(reason);
      }, 50);

      await vi.advanceTimersByTimeAsync(50);
      await cancellation;
      await pending;

      expect(fallback.doStreamCalls).toHaveLength(1);
      expect(attempts).toEqual([
        { attempt: 1, index: 0, outcome: "failure" },
        { attempt: 2, index: 1, outcome: "cancelled" },
      ]);
      expect(route.getHealthSnapshot("chat")).toHaveLength(1);
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 0,
      });
      expect(
        route
          .getAdmissionSnapshot("chat")
          .every(({ inFlight }) => inFlight === 0)
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back when a provider returns a malformed stream result", async () => {
    const malformed = new MockLanguageModelV4({
      doStream: async () => ({}) as never,
    });
    const route = createRouter({
      models: { chat: [malformed, streamingModel(["valid fallback"])] },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("valid fallback");
    expect(malformed.doStreamCalls).toHaveLength(1);
  });

  it("falls back when acquiring a provider stream reader throws", async () => {
    const malformed = new MockLanguageModelV4({
      doStream: (async () =>
        ({
          stream: {
            getReader() {
              throw new Error("reader unavailable");
            },
          },
        }) as never) as never,
    });
    const route = createRouter({
      models: { chat: [malformed, streamingModel(["reader fallback"])] },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("reader fallback");
  });

  it("limits the number of provider attempts", async () => {
    const first = failingModel("first");
    const second = failingModel("second");
    const third = okModel("third");
    const route = createRouter({
      fallback: { maxAttempts: 2 },
      models: { chat: [first, second, third] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).rejects.toThrow();
    expect(third.doGenerateCalls).toHaveLength(0);
  });

  it("isolates mutable call options between fallback attempts", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: (options) => {
        const message = options.prompt[0];
        if (message.role !== "system") {
          const part = message.content[0] as { text?: string };
          part.text = "mutated";
          message.content.length = 0;
        }
        options.prompt.length = 0;
        if (options.headers !== undefined) {
          options.headers.authorization = "mutated";
        }
        options.stopSequences?.push("mutated");
        if (options.providerOptions?.mock !== undefined) {
          options.providerOptions.mock.mode = "mutated";
        }
        throw new Error("primary failed after mutation");
      },
    });
    const secondary = new MockLanguageModelV4({
      doGenerate: (options) => {
        expect(options.prompt).toEqual([
          {
            content: [{ text: "original", type: "text" }],
            role: "user",
          },
        ]);
        expect(options.headers).toEqual({ authorization: "original" });
        expect(options.stopSequences).toEqual(["stop"]);
        expect(options.providerOptions).toEqual({ mock: { mode: "original" } });
        return Promise.resolve({
          content: [{ text: "isolated", type: "text" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const options: LanguageModelV4CallOptions = {
      headers: { authorization: "original" },
      prompt: [
        {
          content: [{ text: "original", type: "text" }],
          role: "user",
        },
      ],
      providerOptions: { mock: { mode: "original" } },
      stopSequences: ["stop"],
    };
    const route = createRouter({ models: { chat: [primary, secondary] } });

    await expect(
      asV4(route("chat")).doGenerate(options)
    ).resolves.toMatchObject({
      content: [{ text: "isolated", type: "text" }],
    });
    expect(options.prompt[0]).toMatchObject({
      content: [{ text: "original", type: "text" }],
    });
    expect(options.headers).toEqual({ authorization: "original" });
    expect(options.stopSequences).toEqual(["stop"]);
    expect(options.providerOptions).toEqual({ mock: { mode: "original" } });
  });

  it("rejects hostile call options before provider and health state mutation", async () => {
    const primary = okModel("must not run");
    const secondary = okModel("must not run either");
    const events: string[] = [];
    const route = createRouter({
      fallback: { health: true, retryBudget: true },
      models: { chat: [primary, secondary] },
      onAttempt: ({ outcome }) => events.push(outcome),
    });
    const hostilePart = Object.defineProperty({ type: "text" }, "text", {
      enumerable: true,
      get() {
        throw new Error("text getter failed");
      },
    });
    const options = {
      prompt: [{ content: [hostilePart], role: "user" }],
    } as LanguageModelV4CallOptions;

    await expect(asV4(route("chat")).doGenerate(options)).rejects.toMatchObject(
      {
        code: "call_options_contract_error",
      }
    );
    let signalReads = 0;
    const hostileSignalOptions = Object.defineProperty(
      { prompt: [] },
      "abortSignal",
      {
        get() {
          signalReads += 1;
          throw new Error("signal getter failed");
        },
      }
    ) as LanguageModelV4CallOptions;
    await expect(
      asV4(route("chat")).doGenerate(hostileSignalOptions)
    ).rejects.toMatchObject({ code: "call_options_contract_error" });
    expect(signalReads).toBe(1);
    expect(primary.doGenerateCalls).toHaveLength(0);
    expect(secondary.doGenerateCalls).toHaveLength(0);
    expect(events).toEqual([]);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
  });

  it("overflows concurrent requests to the next credential", async () => {
    let resolvePrimary:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          resolvePrimary = resolve;
        }),
    });
    const secondary = okModel("overflow");
    const route = createRouter({
      models: {
        chat: [
          { model: primary, healthKey: "primary", maxConcurrency: 1 },
          { model: secondary, healthKey: "secondary", maxConcurrency: 1 },
        ],
      },
    });

    const first = generateText({ model: route("chat"), prompt: "first" });
    await vi.waitFor(() => expect(primary.doGenerateCalls).toHaveLength(1));
    const second = generateText({ model: route("chat"), prompt: "second" });
    await expect(second).resolves.toMatchObject({ text: "overflow" });
    resolvePrimary?.({
      content: [{ type: "text", text: "primary" }],
      finishReason,
      usage,
      warnings: [],
    });
    await expect(first).resolves.toMatchObject({ text: "primary" });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });

  it("shares credential concurrency across logical models", async () => {
    let releaseFirst:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const held = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    });
    const sharedOther = okModel("must overflow");
    const overflow = okModel("overflow");
    const route = createRouter({
      models: {
        first: [{ model: held, healthKey: "shared", maxConcurrency: 1 }],
        second: [
          { model: sharedOther, healthKey: "shared", maxConcurrency: 1 },
          { model: overflow, healthKey: "other", maxConcurrency: 1 },
        ],
      },
    });

    const pending = generateText({ model: route("first"), prompt: "hold" });
    await vi.waitFor(() => expect(held.doGenerateCalls).toHaveLength(1));
    await expect(
      generateText({ model: route("second"), prompt: "overflow" })
    ).resolves.toMatchObject({ text: "overflow" });

    expect(sharedOther.doGenerateCalls).toHaveLength(0);
    expect(route.getAdmissionSnapshot("first")[0].inFlight).toBe(1);
    expect(route.getAdmissionSnapshot("second")[0].inFlight).toBe(1);
    releaseFirst?.({
      content: [{ type: "text", text: "done" }],
      finishReason,
      usage,
      warnings: [],
    });
    await pending;
  });

  it("waits for the final candidate concurrency slot", async () => {
    let call = 0;
    let resolveFirst:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const model = new MockLanguageModelV4({
      doGenerate: () => {
        call += 1;
        if (call === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          content: [{ type: "text", text: "waited" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const route = createRouter({
      fallback: { concurrencyWaitTimeout: 100 },
      models: {
        chat: [{ model, healthKey: "only", maxConcurrency: 1 }],
      },
    });

    const first = generateText({ model: route("chat"), prompt: "first" });
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));
    const second = generateText({ model: route("chat"), prompt: "second" });
    await vi.waitFor(() =>
      expect(route.getAdmissionSnapshot("chat")[0].waiting).toBe(1)
    );
    resolveFirst?.({
      content: [{ type: "text", text: "first" }],
      finishReason,
      usage,
      warnings: [],
    });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("surfaces capacity-only rejection as a concurrency error", async () => {
    let releaseFirst:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const model = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    });
    const route = createRouter({
      models: { chat: [{ model, maxConcurrency: 1 }] },
    });
    const first = asV4(route("chat")).doGenerate(genOptions);
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));

    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toEqual(
      expect.objectContaining({
        code: "concurrency_exhausted",
        name: "RouterConcurrencyError",
      })
    );
    const error = await Promise.resolve(
      asV4(route("chat")).doGenerate(genOptions)
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RouterConcurrencyError);

    releaseFirst?.({
      content: [{ type: "text", text: "done" }],
      finishReason,
      usage,
      warnings: [],
    });
    await first;
  });

  it("aborts while waiting for a concurrency slot", async () => {
    let resolveFirst:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const model = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    });
    const route = createRouter({
      fallback: { concurrencyWaitTimeout: 1000 },
      models: { chat: [{ model, maxConcurrency: 1 }] },
    });
    const first = generateText({ model: route("chat"), prompt: "first" });
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));
    const controller = new AbortController();
    const waiting = asV4(route("chat")).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "wait" }] }],
      abortSignal: controller.signal,
    } as LanguageModelV4CallOptions);
    controller.abort(new DOMException("aborted", "AbortError"));

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    resolveFirst?.({
      content: [{ type: "text", text: "done" }],
      finishReason,
      usage,
      warnings: [],
    });
    await first;
  });

  it("releases waited capacity when post-wait probe preparation throws", async () => {
    let resolveFirst:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    let calls = 0;
    const provider = new MockLanguageModelV4({
      doGenerate: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const route = createRouter({
      fallback: { concurrencyWaitTimeout: 1000 },
      models: { chat: [{ model: provider, maxConcurrency: 1 }] },
    });
    const routedModel = asV4(route("chat"));
    const first = routedModel.doGenerate(genOptions);
    await vi.waitFor(() => expect(provider.doGenerateCalls).toHaveLength(1));

    const originalPrepare = Reflect.get(routedModel, "prepareCandidate");
    let preparations = 0;
    Reflect.set(
      routedModel,
      "prepareCandidate",
      function (this: unknown, candidate: unknown) {
        preparations += 1;
        if (preparations === 2) {
          throw new Error("post-wait preparation failed");
        }
        return Reflect.apply(originalPrepare, this, [candidate]);
      }
    );
    const waiting = routedModel.doGenerate(genOptions);
    await vi.waitFor(() =>
      expect(route.getAdmissionSnapshot("chat")[0].waiting).toBe(1)
    );
    resolveFirst?.({
      content: [{ type: "text", text: "first" }],
      finishReason,
      usage,
      warnings: [],
    });
    await first;

    await expect(waiting).rejects.toMatchObject({
      message: "post-wait preparation failed",
    });
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);

    Reflect.set(routedModel, "prepareCandidate", originalPrepare);
    await expect(routedModel.doGenerate(genOptions)).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("releases stream-open capacity when failure handling throws", async () => {
    let calls = 0;
    const provider = new MockLanguageModelV4({
      doStream: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error("open failed"));
        }
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "ok" },
              { type: "text-end", id: "1" },
              { type: "finish", finishReason, usage },
            ],
          }),
        });
      },
    });
    const route = createRouter({
      models: { chat: [{ model: provider, maxConcurrency: 1 }] },
    });
    const routedModel = asV4(route("chat"));
    const originalHandleFailure = Reflect.get(routedModel, "handleFailure");
    Reflect.set(routedModel, "handleFailure", () => {
      throw new Error("failure handling failed");
    });

    await expect(routedModel.doStream(genOptions)).rejects.toMatchObject({
      message: "failure handling failed",
    });
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);

    Reflect.set(routedModel, "handleFailure", originalHandleFailure);
    const result = await routedModel.doStream(genOptions);
    const reader = result.stream.getReader();
    while (!(await reader.read()).done) {
      // Drain the successful stream so terminal cleanup releases ownership.
    }
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
  });

  it("keeps capacity and probe cleanup independent under infrastructure throws", () => {
    const provider = okModel();
    const route = createRouter({ models: { chat: [provider] } });
    const routedModel = asV4(route("chat"));
    const admission = Reflect.get(routedModel, "admission");
    const health = Reflect.get(routedModel, "health");
    const originalAdmissionRelease = Reflect.get(admission, "release");
    const originalHealthRelease = Reflect.get(health, "releaseProbe");
    const releasedLeases: unknown[] = [];
    const candidate = {
      entry: provider,
      fullIndex: 0,
      model: provider,
      probeLease: { key: "probe", probingUntil: 123 },
    };
    Reflect.set(admission, "release", () => {
      throw new Error("capacity cleanup failed");
    });
    Reflect.set(health, "releaseProbe", (lease: unknown) => {
      releasedLeases.push(lease);
    });

    expect(() =>
      Reflect.apply(
        Reflect.get(routedModel, "releaseCandidateOwnership"),
        routedModel,
        [candidate]
      )
    ).toThrow("capacity cleanup failed");
    expect(releasedLeases).toEqual([{ key: "probe", probingUntil: 123 }]);
    expect(candidate.probeLease).toBeUndefined();

    candidate.probeLease = { key: "second", probingUntil: 456 };
    Reflect.set(admission, "release", originalAdmissionRelease);
    Reflect.set(health, "releaseProbe", () => {
      throw new Error("probe cleanup failed");
    });
    expect(() =>
      Reflect.apply(
        Reflect.get(routedModel, "releaseCandidateProbe"),
        routedModel,
        [candidate]
      )
    ).toThrow("probe cleanup failed");
    expect(candidate.probeLease).toBeUndefined();

    Reflect.set(health, "releaseProbe", originalHealthRelease);
  });

  it.each([
    429, 503,
  ])("adjusts adaptive concurrency with AIMD after status %i", async (statusCode) => {
    let calls = 0;
    const limits: number[] = [];
    const inFlights: number[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: () => {
        calls += 1;
        if (calls === 5) {
          return Promise.reject(
            Object.assign(new Error("limited"), { statusCode })
          );
        }
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const route = createRouter({
      models: {
        chat: [
          {
            model,
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 1,
              max: 3,
              min: 1,
            },
          },
        ],
      },
      onAttempt: ({ concurrencyLimit, inFlight }) => {
        if (concurrencyLimit !== undefined) {
          limits.push(concurrencyLimit);
        }
        if (inFlight !== undefined) {
          inFlights.push(inFlight);
        }
      },
    });
    for (let index = 0; index < 4; index++) {
      await generateText({ model: route("chat"), prompt: String(index) });
    }
    await expect(
      generateText({ model: route("chat"), prompt: "limited" })
    ).rejects.toThrow("limited");

    expect(limits).toEqual([1, 2, 2, 3, 1]);
    expect(inFlights).toEqual([1, 1, 1, 1, 1]);
  });

  it("reports stream AIMD and in-flight metrics at the generate-equivalent settlement point", async () => {
    let calls = 0;
    const limits: number[] = [];
    const inFlights: number[] = [];
    const model = new MockLanguageModelV4({
      doStream: () => {
        calls += 1;
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks:
              calls === 5
                ? [
                    { type: "stream-start", warnings: [] },
                    {
                      type: "error",
                      error: Object.assign(new Error("limited"), {
                        statusCode: 429,
                      }),
                    },
                  ]
                : [
                    { type: "stream-start", warnings: [] },
                    { type: "text-start", id: "1" },
                    { type: "text-delta", id: "1", delta: "ok" },
                    { type: "text-end", id: "1" },
                    { type: "finish", finishReason, usage },
                  ],
          }),
        });
      },
    });
    const route = createRouter({
      models: {
        chat: [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 1,
              max: 3,
              min: 1,
            },
            model,
          },
        ],
      },
      onAttempt: ({ concurrencyLimit, inFlight }) => {
        if (concurrencyLimit !== undefined) {
          limits.push(concurrencyLimit);
        }
        if (inFlight !== undefined) {
          inFlights.push(inFlight);
        }
      },
    });

    for (let index = 0; index < 4; index++) {
      await expect(
        collectStream(
          streamText({ model: route("chat"), prompt: String(index) })
        )
      ).resolves.toBe("ok");
    }
    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "limited" }))
    ).rejects.toThrow("limited");

    expect(limits).toEqual([1, 2, 2, 3, 1]);
    expect(inFlights).toEqual([1, 1, 1, 1, 1]);
  });

  it("preserves post-output stream failure phase and pre-release ownership metrics", async () => {
    const primary = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "partial" },
              {
                type: "error",
                error: Object.assign(new Error("mid-stream limited"), {
                  statusCode: 429,
                }),
              },
            ],
          }),
        }),
    });
    const failures: Array<{
      inFlight?: number;
      limit?: number;
      phase?: string;
    }> = [];
    const route = createRouter({
      fallback: { retryAfterOutput: true },
      models: {
        chat: [
          {
            adaptiveConcurrency: { initial: 2, max: 4, min: 1 },
            model: primary,
          },
          streamingModel(["recovered"]),
        ],
      },
      onAttempt: ({ concurrencyLimit, inFlight, outcome, phase }) => {
        if (outcome === "failure") {
          failures.push({ inFlight, limit: concurrencyLimit, phase });
        }
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("partialrecovered");
    expect(failures).toEqual([{ inFlight: 1, limit: 1, phase: "stream-mid" }]);
  });

  it("does not let an older slow success retrain AIMD after newer congestion", async () => {
    let resolveSlow: (() => void) | undefined;
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            resolveSlow = () =>
              resolve({
                content: [{ type: "text", text: "slow success" }],
                finishReason,
                usage,
                warnings: [],
              });
          });
        }
        return Promise.reject(
          Object.assign(new Error("newer overload"), { statusCode: 503 })
        );
      },
    });
    const route = createRouter({
      models: {
        chat: [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 1,
              initial: 4,
              max: 8,
              min: 1,
            },
            model,
          },
        ],
      },
    });

    const slow = asV4(route("chat")).doGenerate(genOptions);
    await vi.waitFor(() => expect(resolveSlow).toBeTypeOf("function"));
    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toThrow(
      "newer overload"
    );
    resolveSlow?.();
    await expect(slow).resolves.toMatchObject({
      content: [{ type: "text", text: "slow success" }],
    });

    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      limit: 2,
      successes: 0,
    });
  });

  it("recovers reduced AIMD capacity gradually after a half-open probe succeeds", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let calls = 0;
      const primary = new MockLanguageModelV4({
        doGenerate: () => {
          calls += 1;
          if (calls === 1) {
            return Promise.reject(
              Object.assign(new Error("overloaded"), { statusCode: 503 })
            );
          }
          return Promise.resolve({
            content: [{ type: "text", text: "primary recovered" }],
            finishReason,
            usage,
            warnings: [],
          });
        },
      });
      const route = createRouter({
        fallback: { health: true },
        models: {
          chat: [
            {
              adaptiveConcurrency: {
                increaseAfterSuccesses: 2,
                initial: 4,
                max: 8,
                min: 1,
              },
              model: primary,
            },
            { model: okModel("fallback") },
          ],
        },
      });

      await expect(
        generateText({ model: route("chat"), prompt: "fail" })
      ).resolves.toMatchObject({
        text: "fallback",
      });
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        limit: 2,
        successes: 0,
      });
      const cooldownUntil =
        route.getHealthSnapshot("chat")[0].record.cooldownUntil;
      now = cooldownUntil + 1;

      await expect(
        generateText({ model: route("chat"), prompt: "probe" })
      ).resolves.toMatchObject({
        text: "primary recovered",
      });
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        limit: 2,
        successes: 1,
      });

      await expect(
        generateText({ model: route("chat"), prompt: "healthy" })
      ).resolves.toMatchObject({
        text: "primary recovered",
      });
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        limit: 3,
        successes: 0,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("applies one health failure and AIMD decrease per failed stream half-open probe", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const overload = Object.assign(new Error("stream overloaded"), {
        statusCode: 503,
      });
      const primary = errorPartStreamModel(overload);
      const route = createRouter({
        fallback: { health: true },
        models: {
          chat: [
            {
              adaptiveConcurrency: {
                initial: 4,
                max: 8,
                min: 1,
              },
              model: primary,
            },
            { model: streamingModel(["fallback"]) },
          ],
        },
      });

      await expect(
        collectStream(streamText({ model: route("chat"), prompt: "first" }))
      ).resolves.toBe("fallback");
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({ limit: 2 });
      expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(1);

      now = route.getHealthSnapshot("chat")[0].record.cooldownUntil + 1;
      await expect(
        collectStream(streamText({ model: route("chat"), prompt: "probe" }))
      ).resolves.toBe("fallback");

      expect(primary.doStreamCalls).toHaveLength(2);
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({ limit: 1 });
      expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("shares health and gradual AIMD recovery across logical models with one credential", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let firstCalls = 0;
      const firstPrimary = new MockLanguageModelV4({
        doGenerate: () => {
          firstCalls += 1;
          if (firstCalls === 1) {
            return Promise.reject(
              Object.assign(new Error("shared rate limit"), { statusCode: 429 })
            );
          }
          return Promise.resolve({
            content: [{ type: "text", text: "first recovered" }],
            finishReason,
            usage,
            warnings: [],
          });
        },
      });
      const secondPrimary = okModel("second recovered");
      const adaptiveConcurrency = {
        increaseAfterSuccesses: 2,
        initial: 4,
        max: 8,
        min: 1,
      };
      const route = createRouter({
        fallback: { health: true, healthNamespace: "shared-recovery" },
        models: {
          first: [
            {
              adaptiveConcurrency,
              healthKey: "shared-credential",
              model: firstPrimary,
            },
            { model: okModel("first fallback") },
          ],
          second: [
            {
              adaptiveConcurrency,
              healthKey: "shared-credential",
              model: secondPrimary,
            },
            { model: okModel("second fallback") },
          ],
        },
      });

      await expect(
        generateText({ model: route("first"), prompt: "fail" })
      ).resolves.toMatchObject({
        text: "first fallback",
      });
      expect(route.getAdmissionSnapshot("first")[0]).toMatchObject({
        limit: 2,
      });
      expect(route.getAdmissionSnapshot("second")[0]).toMatchObject({
        limit: 2,
      });

      await expect(
        generateText({ model: route("second"), prompt: "cooling" })
      ).resolves.toMatchObject({
        text: "second fallback",
      });
      expect(secondPrimary.doGenerateCalls).toHaveLength(0);

      const cooldownUntil = route
        .getHealthSnapshot()
        .find(({ key }) => key.includes(":credential:"))?.record.cooldownUntil;
      if (cooldownUntil === undefined) {
        throw new Error("expected shared credential cooldown");
      }
      now = cooldownUntil + 1;
      await expect(
        generateText({ model: route("second"), prompt: "probe" })
      ).resolves.toMatchObject({
        text: "second recovered",
      });
      expect(route.getAdmissionSnapshot("first")[0]).toMatchObject({
        limit: 2,
        successes: 1,
      });

      await expect(
        generateText({ model: route("first"), prompt: "healthy" })
      ).resolves.toMatchObject({
        text: "first recovered",
      });
      expect(route.getAdmissionSnapshot("second")[0]).toMatchObject({
        limit: 3,
        successes: 0,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects conflicting concurrency settings for a shared health key", () => {
    expect(() => {
      const route = createRouter({
        models: {
          chat: [
            { model: okModel("a"), healthKey: "shared", maxConcurrency: 1 },
            { model: okModel("b"), healthKey: "shared", maxConcurrency: 2 },
          ],
        },
      });
      route("chat");
    }).toThrow("must use identical concurrency settings");
  });

  it("rejects empty provider families and unknown selection policies", () => {
    expect(() => {
      const route = createRouter({
        models: { chat: [{ model: okModel(), providerFamily: " " }] },
      });
      route("chat");
    }).toThrow("providerFamily must not be empty");

    expect(() => {
      const route = createRouter({
        fallback: { selection: "random" as never },
        models: { chat: [okModel()] },
      });
      route("chat");
    }).toThrow("selection must be");
  });

  it("rejects sparse candidate arrays eagerly", () => {
    expect(() =>
      createRouter({
        models: { chat: new Array(1) as never },
      })
    ).toThrow("candidate array must not contain holes");
    expect(() =>
      createRouter({
        models: { chat: new Array(10_001) as never },
      })
    ).toThrow("exceeds 10000 candidates");
  });

  it("rejects conflicting effective AIMD initial limits", () => {
    expect(() =>
      createRouter({
        models: {
          chat: [
            {
              adaptiveConcurrency: { max: 2 },
              maxConcurrency: 4,
              model: okModel(),
            },
          ],
        },
      })
    ).toThrow("min <= initial <= max");
    expect(() =>
      createRouter({
        models: {
          chat: [
            {
              adaptiveConcurrency: { min: 3 },
              maxConcurrency: 2,
              model: okModel(),
            },
          ],
        },
      })
    ).toThrow("min <= initial <= max");
  });

  it("supports round-robin candidate selection", async () => {
    const route = createRouter({
      fallback: { selection: "round-robin" },
      models: { chat: [okModel("a"), okModel("b")] },
    });

    const outputs: string[] = [];
    for (const prompt of ["one", "two", "three"]) {
      outputs.push((await generateText({ model: route("chat"), prompt })).text);
    }
    expect(outputs).toEqual(["a", "b", "a"]);
  });

  it("does not rotate round-robin state for an already-aborted request", async () => {
    const first = okModel("a");
    const second = okModel("b");
    const route = createRouter({
      fallback: { selection: "round-robin" },
      models: { chat: [first, second] },
    });
    const controller = new AbortController();
    const reason = new Error("cancelled before routing");
    controller.abort(reason);

    await expect(
      asV4(route("chat")).doGenerate({
        ...genOptions,
        abortSignal: controller.signal,
      })
    ).rejects.toBe(reason);
    await expect(
      generateText({ model: route("chat"), prompt: "real request" })
    ).resolves.toMatchObject({ text: "a" });
    expect(first.doGenerateCalls).toHaveLength(1);
    expect(second.doGenerateCalls).toHaveLength(0);
  });

  it("rechecks shared health before each fallback attempt", async () => {
    const rejectPrimary: Array<(reason?: unknown) => void> = [];
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((_, reject) => {
          rejectPrimary.push(reject);
        }),
    });
    const secondary = failingModelStatus(429, "secondary limited");
    const tertiary = okModel("tertiary");
    const route = createRouter({
      fallback: { health: true },
      models: {
        chat: [
          { model: primary, healthKey: "primary" },
          { model: secondary, healthKey: "secondary" },
          { model: tertiary, healthKey: "tertiary" },
        ],
      },
    });
    const requests = ["a", "b", "c"].map((prompt) =>
      generateText({ model: route("chat"), prompt })
    );
    await vi.waitFor(() => expect(rejectPrimary).toHaveLength(3));

    rejectPrimary[0](
      Object.assign(new Error("primary limited"), { statusCode: 429 })
    );
    await vi.waitFor(() => expect(secondary.doGenerateCalls).toHaveLength(1));
    await vi.waitFor(() => expect(tertiary.doGenerateCalls).toHaveLength(1));
    rejectPrimary[1](
      Object.assign(new Error("primary limited"), { statusCode: 429 })
    );
    rejectPrimary[2](
      Object.assign(new Error("primary limited"), { statusCode: 429 })
    );

    await expect(Promise.all(requests)).resolves.toHaveLength(3);
    expect(secondary.doGenerateCalls).toHaveLength(1);
    expect(tertiary.doGenerateCalls).toHaveLength(3);
  });

  it("emits attempt-level observability events", async () => {
    const events: Array<{ outcome: string; willRetry?: boolean }> = [];
    const route = createRouter({
      models: { chat: [failingModel("down"), okModel("ok")] },
      onAttempt: ({ outcome, willRetry }) =>
        events.push({ outcome, willRetry }),
    });

    await generateText({ model: route("chat"), prompt: "hi" });
    expect(events).toEqual([
      { outcome: "failure", willRetry: true },
      { outcome: "success", willRetry: undefined },
    ]);
  });

  it("omits attempt numbers from events that did not call a provider", async () => {
    const events: Array<{ attempt?: number; outcome: string }> = [];
    const route = createRouter({
      fallback: { maxAttempts: 1 },
      models: { chat: [failingModel("down"), okModel("skipped")] },
      onAttempt: ({ attempt, outcome }) => events.push({ attempt, outcome }),
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).rejects.toThrow("down");
    expect(events).toEqual([
      { attempt: 1, outcome: "failure" },
      { attempt: undefined, outcome: "skipped" },
    ]);
  });

  it("does not instantiate factories skipped by maxAttempts", async () => {
    const generateError = new Error("generate failed");
    const streamError = new Error("stream failed");
    const failedStream = errorPartStreamModel(streamError);
    const primary = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(generateError),
      doStream: (options) => failedStream.doStream(options),
    });
    let factoryCalls = 0;
    const events: Array<{
      attempt?: number;
      outcome: string;
      phase: string;
    }> = [];
    const route = createRouter({
      fallback: { maxAttempts: 1 },
      models: {
        chat: [
          primary,
          {
            model: "lazy-fallback",
            provider: () => {
              factoryCalls += 1;
              return okModel("must stay lazy");
            },
            supports: ["text"],
          },
        ],
      },
      onAttempt: ({ attempt, outcome, phase }) =>
        events.push({ attempt, outcome, phase }),
    });

    await expect(
      generateText({ model: route("chat"), prompt: "generate" })
    ).rejects.toBe(generateError);
    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "stream" }))
    ).rejects.toBe(streamError);

    expect(factoryCalls).toBe(0);
    expect(events).toEqual([
      { attempt: 1, outcome: "failure", phase: "generate" },
      { attempt: undefined, outcome: "skipped", phase: "generate" },
      { attempt: 1, outcome: "failure", phase: "stream-open" },
      { attempt: undefined, outcome: "skipped", phase: "stream-open" },
    ]);
  });

  it("preserves partial output without instantiating a maxAttempts-blocked factory", async () => {
    const streamError = new Error("post-output stream failed");
    const primary = readErrorStreamModel(streamError, "partial");
    let factoryCalls = 0;
    const events: Array<{
      attempt?: number;
      outcome: string;
      phase: string;
      reason?: string;
    }> = [];
    const route = createRouter({
      fallback: { maxAttempts: 1, retryAfterOutput: true },
      models: {
        chat: [
          primary,
          {
            model: "lazy-fallback",
            provider: () => {
              factoryCalls += 1;
              return streamingModel(["must not run"]);
            },
            supports: ["text"],
          },
        ],
      },
      onAttempt: ({ attempt, outcome, phase, reason }) =>
        events.push({ attempt, outcome, phase, reason }),
    });

    const result = await asV4(route("chat")).doStream(genOptions);
    const { error: caught, text } = await collectRawStream(result.stream);

    expect(text).toBe("partial");
    expect(caught).toBe(streamError);
    expect(factoryCalls).toBe(0);
    expect(events).toEqual([
      {
        attempt: 1,
        outcome: "failure",
        phase: "stream-mid",
        reason: undefined,
      },
      {
        attempt: undefined,
        outcome: "skipped",
        phase: "stream-mid",
        reason: "max-attempts",
      },
    ]);
  });

  it("settles post-output error-part health and budget when maxAttempts blocks fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const streamError = Object.assign(new Error("credential limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { id: "primary", type: "text-start" },
            { delta: "partial", id: "primary", type: "text-delta" },
            { error: streamError, type: "error" },
          ],
        }),
      }),
    });
    let blockedFactoryCalls = 0;
    const events: Array<{
      attempt?: number;
      outcome: string;
      phase: string;
      reason?: string;
    }> = [];
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "post-output-error-part-max-attempts",
        maxAttempts: 1,
        retryAfterOutput: true,
        retryBudget: true,
      },
      models: {
        first: [
          { healthKey: "shared-key", model: primary },
          {
            model: "blocked-fallback",
            provider: () => {
              blockedFactoryCalls += 1;
              return streamingModel(["must not run"]);
            },
            supports: ["text"],
          },
        ],
        second: [
          { healthKey: "shared-key", model: primary },
          streamingModel(["cooldown fallback"]),
        ],
      },
      onAttempt: ({ attempt, outcome, phase, reason }) =>
        events.push({ attempt, outcome, phase, reason }),
    });

    const result = await asV4(route("first")).doStream(genOptions);
    const { error: caught, text } = await collectRawStream(result.stream);

    expect(text).toBe("partial");
    expect(caught).toBe(streamError);
    expect(blockedFactoryCalls).toBe(0);
    expect(events).toEqual([
      {
        attempt: 1,
        outcome: "failure",
        phase: "stream-mid",
        reason: undefined,
      },
      {
        attempt: undefined,
        outcome: "skipped",
        phase: "stream-mid",
        reason: "max-attempts",
      },
    ]);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 1,
      samples: 1,
    });
    expect(route.getAdmissionSnapshot("first")[0].inFlight).toBe(0);
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(1);

    await expect(
      collectStream(streamText({ model: route("second"), prompt: "cooling" }))
    ).resolves.toBe("cooldown fallback");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(route.getRetryBudgetSnapshot("second")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
    expect(route.getAdmissionSnapshot("second")[1].inFlight).toBe(0);
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(1);
    vi.useRealTimers();
  });

  it("isolates rejected async observability hooks", async () => {
    const route = createRouter({
      models: { chat: [failingModel("down"), okModel("recovered")] },
      onAttempt: () => Promise.reject(new Error("async attempt hook failed")),
      onError: () => Promise.reject(new Error("async error hook failed")),
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "recovered" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("reports willRetry false when every remaining candidate is at capacity", async () => {
    let releaseHolder:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const holder = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          releaseHolder = resolve;
        }),
    });
    const retryCandidate = okModel("must not run");
    const decisions: Array<boolean | undefined> = [];
    const route = createRouter({
      models: {
        holder: [{ model: holder, healthKey: "shared", maxConcurrency: 1 }],
        chat: [
          failingModel("primary failed"),
          {
            model: retryCandidate,
            healthKey: "shared",
            maxConcurrency: 1,
          },
        ],
      },
      onError: ({ logicalId, willRetry }) => {
        if (logicalId === "chat") {
          decisions.push(willRetry);
        }
      },
    });

    const held = asV4(route("holder")).doGenerate(genOptions);
    await vi.waitFor(() => expect(holder.doGenerateCalls).toHaveLength(1));
    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toThrow(
      "primary failed"
    );

    expect(decisions).toEqual([false]);
    expect(retryCandidate.doGenerateCalls).toHaveLength(0);
    releaseHolder?.({
      content: [{ type: "text", text: "done" }],
      finishReason,
      usage,
      warnings: [],
    });
    await held;
  });

  it("reports willRetry true when the next candidate reuses the released slot", async () => {
    const decisions: Array<boolean | undefined> = [];
    const fallback = okModel("shared-slot fallback");
    const route = createRouter({
      models: {
        chat: [
          {
            healthKey: "shared",
            maxConcurrency: 1,
            model: failingModel("primary failed"),
          },
          { healthKey: "shared", maxConcurrency: 1, model: fallback },
        ],
      },
      onError: ({ willRetry }) => decisions.push(willRetry),
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "shared-slot fallback" });
    expect(decisions).toEqual([true]);
    expect(fallback.doGenerateCalls).toHaveLength(1);
  });

  it("keeps observability indexes stable after modality filtering", async () => {
    const indexes: number[] = [];
    const route = createRouter({
      models: {
        chat: [
          { model: okModel("image"), supports: ["image"] },
          { model: failingModel("down"), supports: ["text"] },
          { model: okModel("ok"), supports: ["text"] },
        ],
      },
      onAttempt: ({ index }) => indexes.push(index),
    });

    await generateText({ model: route("chat"), prompt: "hi" });
    expect(indexes).toEqual([1, 2]);
  });

  it("counts stream-open failures toward the retry budget", async () => {
    const primary = failingStreamModel("primary open failed");
    const secondary = failingStreamModel("secondary open failed");
    const retries: Array<boolean | undefined> = [];
    const route = createRouter({
      fallback: { retryBudget: true },
      models: { chat: [primary, secondary] },
      onError: ({ willRetry }) => retries.push(willRetry),
    });
    const model = asV4(route("chat"));

    for (let request = 0; request < 6; request++) {
      await expect(model.doStream(genOptions)).rejects.toThrow();
    }

    expect(primary.doStreamCalls).toHaveLength(6);
    expect(secondary.doStreamCalls).toHaveLength(5);
    expect(retries.at(-1)).toBe(false);
  });

  it("does not trip the request budget when a deep fallback succeeds", async () => {
    const failures = Array.from({ length: 4 }, (_, index) =>
      failingModel(`failure-${index}`)
    );
    const survivor = okModel("survivor");
    const route = createRouter({
      fallback: { retryBudget: true },
      models: { chat: [...failures, survivor] },
    });
    const model = asV4(route("chat"));

    for (let request = 0; request < 6; request++) {
      await expect(model.doGenerate(genOptions)).resolves.toMatchObject({
        content: [{ type: "text", text: "survivor" }],
      });
    }

    expect(failures[0].doGenerateCalls).toHaveLength(6);
    expect(survivor.doGenerateCalls).toHaveLength(6);
  });

  it("trips the retry budget on repeated credential rate-limit failures", async () => {
    const primary = failingModelStatus(429, "primary limited");
    const secondary = failingModelStatus(429, "secondary limited");
    const route = createRouter({
      fallback: { retryBudget: true },
      models: { chat: [primary, secondary] },
    });

    for (let request = 0; request < 6; request++) {
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).rejects.toThrow();
    }

    expect(primary.doGenerateCalls).toHaveLength(6);
    expect(secondary.doGenerateCalls).toHaveLength(5);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 6,
      tripped: true,
    });
  });

  it("does not charge a cooling candidate against a tripped retry budget", async () => {
    const store = new MemoryRouterHealthStore();
    const primary = failingModelStatus(503, "primary overloaded");
    let secondaryCalls = 0;
    const secondary = new MockLanguageModelV4({
      doGenerate: () => {
        secondaryCalls += 1;
        if (secondaryCalls === 1) {
          return Promise.reject(
            Object.assign(new Error("secondary overloaded"), {
              statusCode: 503,
            })
          );
        }
        return Promise.resolve({
          content: [{ type: "text", text: "secondary recovered" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const route = createRouter({
      fallback: {
        health: true,
        healthStore: store,
        retryBudget: {
          minSamples: 1,
          recoveryFailureRate: 0.4,
          tripFailureRate: 1,
        },
      },
      models: { chat: [primary, secondary] },
    });

    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toThrow();
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      samples: 1,
      tripped: true,
    });
    store.delete("logical:chat:unit:1");

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "secondary recovered" }],
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failureRate: 0.5,
      samples: 2,
      tripped: true,
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "secondary recovered" }],
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 1,
      samples: 3,
      tripped: false,
    });

    store.delete("logical:chat:unit:0");
    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "secondary recovered" }],
    });
    expect(primary.doGenerateCalls).toHaveLength(2);
    expect(secondary.doGenerateCalls).toHaveLength(4);
  });

  it("does not charge a saturated candidate against a tripped retry budget", async () => {
    let resolvePrimary:
      | ((result: LanguageModelV4GenerateResult) => void)
      | undefined;
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          resolvePrimary = resolve;
        }),
    });
    const secondary = okModel("capacity fallback");
    const route = createRouter({
      fallback: {
        retryBudget: {
          minSamples: 1,
          recoveryFailureRate: 0.4,
          tripFailureRate: 1,
        },
      },
      models: {
        chat: [{ maxConcurrency: 1, model: primary }, secondary],
      },
    });
    const routed = asV4(route("chat"));
    const occupying = routed.doGenerate(genOptions);
    await vi.waitFor(() => expect(resolvePrimary).toBeTypeOf("function"));
    const budget = Reflect.get(routed, "retryBudget") as {
      observe: (success: boolean) => void;
    };
    budget.observe(false);

    await expect(routed.doGenerate(genOptions)).resolves.toMatchObject({
      content: [{ type: "text", text: "capacity fallback" }],
    });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);

    resolvePrimary?.({
      content: [{ type: "text", text: "primary done" }],
      finishReason,
      usage,
      warnings: [],
    });
    await occupying;
  });

  it("does not charge a cooling stream candidate against a tripped retry budget", async () => {
    const store = new MemoryRouterHealthStore();
    store.set("logical:chat:unit:0", {
      cooldownUntil: Date.now() + 60_000,
      failures: 1,
      lastFailureAt: 1,
      observedAtMs: Date.now(),
    });
    const primary = streamingModel(["must not open"]);
    const secondary = streamingModel(["stream fallback"]);
    const attempts: Array<{
      attempt?: number;
      index: number;
      outcome: string;
    }> = [];
    const route = createRouter({
      fallback: {
        health: true,
        healthStore: store,
        retryBudget: {
          minSamples: 1,
          recoveryFailureRate: 0.4,
          tripFailureRate: 1,
        },
      },
      models: { chat: [primary, secondary] },
      onAttempt: ({ attempt, index, outcome }) => {
        attempts.push({ attempt, index, outcome });
      },
    });
    const routed = asV4(route("chat"));
    const budget = Reflect.get(routed, "retryBudget") as {
      observe: (success: boolean) => void;
    };
    budget.observe(false);

    await expect(
      collectStream(streamText({ model: routed, prompt: "stream" }))
    ).resolves.toBe("stream fallback");

    expect(primary.doStreamCalls).toHaveLength(0);
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(attempts).toEqual([
      { attempt: undefined, index: 0, outcome: "skipped" },
      { attempt: 1, index: 1, outcome: "success" },
    ]);
  });

  it("does not recover a tripped retry budget from consumer-cancelled fallback stream", async () => {
    const store = new MemoryRouterHealthStore();
    store.set("logical:chat:unit:0", {
      cooldownUntil: Date.now() + 60_000,
      failures: 1,
      lastFailureAt: 1,
      observedAtMs: Date.now(),
    });
    const primary = streamingModel(["must not open"]);
    const attempts: Array<{ index: number; outcome: string }> = [];
    let transportCancelled = false;
    const secondary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
          },
          cancel() {
            transportCancelled = true;
          },
        }),
      }),
    });
    const route = createRouter({
      fallback: {
        health: true,
        healthStore: store,
        retryBudget: {
          minSamples: 1,
          recoveryFailureRate: 0.4,
          tripFailureRate: 1,
        },
      },
      models: {
        chat: [
          primary,
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: secondary,
          },
        ],
      },
      onAttempt: ({ index, outcome }) => attempts.push({ index, outcome }),
    });
    const routed = asV4(route("chat"));
    const budget = Reflect.get(routed, "retryBudget") as {
      observe: (success: boolean) => void;
    };
    budget.observe(false);
    const result = await routed.doStream(genOptions);
    const reader = result.stream.getReader();
    const pendingRead = reader.read();
    await vi.waitFor(() => expect(secondary.doStreamCalls).toHaveLength(1));

    await reader.cancel("consumer stopped");
    await pendingRead;

    expect(transportCancelled).toBe(true);
    expect(primary.doStreamCalls).toHaveLength(0);
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      successes: 0,
    });
    expect(attempts).toEqual([
      { index: 0, outcome: "skipped" },
      { index: 1, outcome: "cancelled" },
    ]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 1,
      samples: 1,
      tripped: true,
    });
  });

  it("keeps one recovery outcome when consumer cancel follows validated finish", async () => {
    const store = new MemoryRouterHealthStore();
    store.set("logical:chat:unit:0", {
      cooldownUntil: Date.now() + 60_000,
      failures: 1,
      lastFailureAt: 1,
      observedAtMs: Date.now(),
    });
    const primary = streamingModel(["must not open"]);
    const secondary = streamingModel(["finished fallback"]);
    const attempts: Array<{ index: number; outcome: string }> = [];
    const route = createRouter({
      fallback: {
        health: true,
        healthStore: store,
        retryBudget: {
          minSamples: 1,
          recoveryFailureRate: 0.4,
          tripFailureRate: 1,
        },
      },
      models: {
        chat: [
          primary,
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: secondary,
          },
        ],
      },
      onAttempt: ({ index, outcome }) => attempts.push({ index, outcome }),
    });
    const routed = asV4(route("chat"));
    const budget = Reflect.get(routed, "retryBudget") as {
      observe: (success: boolean) => void;
    };
    budget.observe(false);
    const result = await routed.doStream(genOptions);
    const reader = result.stream.getReader();
    let sawFinish = false;
    while (!sawFinish) {
      const next = await reader.read();
      if (next.done) {
        throw new Error("stream closed before finish");
      }
      sawFinish = next.value.type === "finish";
    }

    await reader.cancel("consumer stopped after finish");

    expect(primary.doStreamCalls).toHaveLength(0);
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      successes: 1,
    });
    expect(attempts).toEqual([
      { index: 0, outcome: "skipped" },
      { index: 1, outcome: "success" },
    ]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failureRate: 0.5,
      failures: 1,
      samples: 2,
      tripped: true,
    });
  });

  it("exposes configured retry budget state per logical model", async () => {
    const route = createRouter({
      fallback: {
        retryBudget: {
          minSamples: 2,
          tripFailureRate: 0.5,
          window: "30s",
        },
      },
      models: { chat: [failingModel("down")] },
    });
    const model = asV4(route("chat"));
    await expect(model.doGenerate(genOptions)).rejects.toThrow("down");
    await expect(model.doGenerate(genOptions)).rejects.toThrow("down");

    expect(route.getRetryBudgetSnapshot("chat")).toEqual([
      expect.objectContaining({
        available: false,
        failureRate: 1,
        failures: 2,
        logicalId: "chat",
        samples: 2,
        tripped: true,
        windowMs: 30_000,
      }),
    ]);
    expect(route.getRetryBudgetSnapshot("unknown")).toEqual([]);
  });

  it("does not count caller aborts against the retry budget", async () => {
    const primary = failingModel("provider failed");
    const secondary = okModel("recovered");
    const route = createRouter({
      fallback: { retryBudget: true },
      models: { chat: [primary, secondary] },
    });
    const model = asV4(route("chat"));

    for (let request = 0; request < 5; request++) {
      const controller = new AbortController();
      controller.abort(new DOMException("cancelled", "AbortError"));
      await expect(
        model.doGenerate({ ...genOptions, abortSignal: controller.signal })
      ).rejects.toMatchObject({ name: "AbortError" });
    }

    await expect(model.doGenerate(genOptions)).resolves.toMatchObject({
      content: [{ type: "text", text: "recovered" }],
    });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });

  it("does not settle the retry budget when a consumer cancels during fallback", async () => {
    const fallback = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
          },
        }),
      }),
    });
    const route = createRouter({
      fallback: { retryBudget: true },
      models: {
        chat: [errorPartStreamModel(new Error("primary failed")), fallback],
      },
    });
    const result = await asV4(route("chat")).doStream(genOptions);
    const reader = result.stream.getReader();
    const pendingRead = reader.read();
    await vi.waitFor(() => expect(fallback.doStreamCalls).toHaveLength(1));

    await reader.cancel("consumer stopped");
    await pendingRead;

    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
  });

  it("caches one routed model per logical id", () => {
    const route = createRouter({ models: { chat: [okModel()] } });
    expect(route("chat")).toBe(route("chat"));
  });

  it("rejects invalid maxAttempts", () => {
    expect(() =>
      createRouter({
        fallback: { maxAttempts: Number.POSITIVE_INFINITY },
        models: { chat: [okModel()] },
      })("chat")
    ).toThrow(MAX_ATTEMPTS_RE);
    expect(() =>
      createRouter({
        fallback: { maxAttempts: 1e300 },
        models: { chat: [okModel()] },
      })
    ).toThrow(MAX_ATTEMPTS_RE);
  });

  it("shares health through an external store and exposes snapshots", async () => {
    const store = new MemoryRouterHealthStore();
    const primary = failingModel("down");
    const secondary = okModel("ok");
    const options = {
      fallback: { health: true, healthStore: store },
      models: { chat: [primary, secondary] },
    };
    const first = createRouter(options);
    await generateText({ model: first("chat"), prompt: "one" });
    expect(first.getHealthSnapshot("chat")).toHaveLength(1);

    const second = createRouter(options);
    await generateText({ model: second("chat"), prompt: "two" });
    expect(primary.doGenerateCalls).toHaveLength(1);
  });

  it("does not retry a failed credential when shared health writes fail", async () => {
    class UnavailableStore extends MemoryRouterHealthStore {
      override get(): never {
        throw new Error("health store unavailable");
      }

      override set(): never {
        throw new Error("health store unavailable");
      }

      override compareAndSet(): never {
        throw new Error("health store unavailable");
      }
    }
    const rateLimited = failingModelStatus(429, "credential rate limited");
    const duplicateCredential = okModel("must be skipped");
    const independentCredential = okModel("independent fallback");
    const route = createRouter({
      fallback: { health: true, healthStore: new UnavailableStore() },
      models: {
        chat: [
          { healthKey: "shared", model: rateLimited },
          { healthKey: "shared", model: duplicateCredential },
          { healthKey: "independent", model: independentCredential },
        ],
      },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "independent fallback" }],
    });
    expect(rateLimited.doGenerateCalls).toHaveLength(1);
    expect(duplicateCredential.doGenerateCalls).toHaveLength(0);
    expect(independentCredential.doGenerateCalls).toHaveLength(1);
  });

  it("reads configured health snapshots before the routed model is requested", () => {
    const store = new MemoryRouterHealthStore();
    store.set("logical:chat:unit:0", {
      cooldownUntil: Date.now() + 1000,
      failures: 1,
      observedAtMs: Date.now(),
    });
    const provider = vi.fn(() => okModel("unused"));
    const route = createRouter({
      fallback: { health: true, healthStore: store },
      models: { chat: [{ provider, model: "model" }] },
    });

    expect(route.getHealthSnapshot("chat")).toHaveLength(1);
    expect(provider).not.toHaveBeenCalled();
  });

  it("isolates public diagnostic snapshots from caller mutation", () => {
    const store = new MemoryRouterHealthStore();
    store.set("logical:chat:unit:0", {
      cooldownUntil: Date.now() + 1000,
      failures: 2,
      observedAtMs: Date.now(),
    });
    const route = createRouter({
      fallback: { health: true, healthStore: store, retryBudget: true },
      models: {
        chat: [
          {
            adaptiveConcurrency: { initial: 2, max: 4, min: 1 },
            model: okModel(),
          },
        ],
      },
    });
    const health = route.getHealthSnapshot("chat");
    const admission = route.getAdmissionSnapshot("chat");
    const budget = route.getRetryBudgetSnapshot("chat");

    health[0].record.failures = 0;
    admission[0].inFlight = 99;
    budget[0].samples = 99;

    expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(2);
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
    expect(route.getRetryBudgetSnapshot("chat")[0].samples).toBe(0);
  });

  it("discovers pre-request shared credential records without exposing identity", () => {
    const store = new MemoryRouterHealthStore();
    store.set("scope:production:credential:secret-key", {
      cooldownUntil: Date.now() + 1000,
      failures: 1,
      observedAtMs: Date.now(),
    });
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "production",
        healthStore: store,
      },
      models: {
        chat: [{ model: okModel(), healthKey: "secret-key" }],
      },
    });

    const snapshot = route.getHealthSnapshot("chat");
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].key).toContain(":credential:#");
    expect(snapshot[0].key).not.toContain("secret-key");
  });

  it("does not bypass active cooldown when every candidate is cooling", async () => {
    const first = failingModelStatus(503, "first down");
    const second = failingModelStatus(503, "second down");
    const skipped: number[] = [];
    const route = createRouter({
      fallback: { health: true },
      models: { chat: [first, second] },
      onAttempt: ({ index, outcome, reason }) => {
        if (outcome === "skipped" && reason === "cooldown") {
          skipped.push(index);
        }
      },
    });
    const model = asV4(route("chat"));

    await expect(model.doGenerate(genOptions)).rejects.toThrow();
    const unavailable = await Promise.resolve(
      model.doGenerate(genOptions)
    ).catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(RouterHealthUnavailableError);
    expect(unavailable).toMatchObject({ code: "health_unavailable" });
    expect(first.doGenerateCalls).toHaveLength(1);
    expect(second.doGenerateCalls).toHaveLength(1);
    expect(skipped).toEqual([0, 1]);
  });

  it("isolates shared health by service namespace", async () => {
    const store = new MemoryRouterHealthStore();
    const primary = failingModel("down");
    const secondary = okModel("ok");
    const create = (healthNamespace: string) =>
      createRouter({
        fallback: { health: true, healthNamespace, healthStore: store },
        models: {
          chat: [
            { model: primary, healthKey: "shared-key" },
            { model: secondary, healthKey: "secondary" },
          ],
        },
      });

    await generateText({ model: create("service-a")("chat"), prompt: "a" });
    await generateText({ model: create("service-b")("chat"), prompt: "b" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("isolates default health stores between router instances", async () => {
    const primary = failingModelStatus(429, "credential limited");
    const create = () =>
      createRouter({
        fallback: { health: true, healthNamespace: "production" },
        models: {
          chat: [
            { healthKey: "shared-key", model: primary },
            { healthKey: "fallback", model: okModel("fallback") },
          ],
        },
      });

    await generateText({ model: create()("chat"), prompt: "one" });
    await generateText({ model: create()("chat"), prompt: "two" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("shares default provider-family health across logical models", async () => {
    const familyFailure = failingModel("family unavailable");
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "production-family",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: familyFailure,
            providerFamily: "shared-family",
          },
          {
            healthKey: "first-fallback",
            model: okModel("first fallback"),
            providerFamily: "first",
          },
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: familyFailure,
            providerFamily: "shared-family",
          },
          {
            healthKey: "second-fallback",
            model: okModel("second fallback"),
            providerFamily: "second",
          },
        ],
      },
    });

    await generateText({ model: route("first"), prompt: "one" });
    await generateText({ model: route("second"), prompt: "two" });

    expect(familyFailure.doGenerateCalls).toHaveLength(1);
    expect(
      route.getHealthSnapshot().filter(({ key }) => key.includes(":family:"))
    ).toHaveLength(1);
    expect(
      route.getHealthSnapshot().some(({ key }) => key.includes(":credential:"))
    ).toBe(false);
  });

  it("shares stream provider-family outage across credential keys", async () => {
    const familyFailure = errorPartStreamModel(new Error("family unavailable"));
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "production-stream-family",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: familyFailure,
            providerFamily: "shared-family",
          },
          {
            healthKey: "first-fallback",
            model: streamingModel(["first fallback"]),
            providerFamily: "first",
          },
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: familyFailure,
            providerFamily: "shared-family",
          },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second fallback"]),
            providerFamily: "second",
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "one" }))
    ).resolves.toBe("first fallback");
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "two" }))
    ).resolves.toBe("second fallback");

    expect(familyFailure.doStreamCalls).toHaveLength(1);
    expect(
      route.getHealthSnapshot().filter(({ key }) => key.includes(":family:"))
    ).toHaveLength(1);
    expect(
      route.getHealthSnapshot().some(({ key }) => key.includes(":credential:"))
    ).toBe(false);
  });

  it("recovers a provider family across credential keys after one generate probe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    const family = new MockLanguageModelV4({
      doGenerate: () =>
        healthy
          ? Promise.resolve({
              content: [{ text: "family recovered", type: "text" }],
              finishReason,
              usage,
              warnings: [],
            })
          : Promise.reject(new Error("family unavailable")),
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-generate-recovery",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          okModel("first fallback"),
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          okModel("second fallback"),
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "outage" })
    ).resolves.toMatchObject({ text: "first fallback" });
    await expect(
      generateText({ model: route("second"), prompt: "skip" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(family.doGenerateCalls).toHaveLength(1);

    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    await expect(
      generateText({ model: route("first"), prompt: "probe" })
    ).resolves.toMatchObject({ text: "family recovered" });
    await expect(
      generateText({ model: route("second"), prompt: "shared recovery" })
    ).resolves.toMatchObject({ text: "family recovered" });

    expect(family.doGenerateCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    expect(
      route.getAdmissionSnapshot().every(({ inFlight }) => inFlight === 0)
    ).toBe(true);
    vi.useRealTimers();
  });

  it("recovers a provider family across credential keys after one stream probe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    const failedStream = errorPartStreamModel(new Error("family unavailable"));
    const recoveredStream = streamingModel(["family recovered"]);
    const family = new MockLanguageModelV4({
      doStream: (options) =>
        healthy
          ? recoveredStream.doStream(options)
          : failedStream.doStream(options),
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-stream-recovery",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["first fallback"]),
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["second fallback"]),
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "outage" }))
    ).resolves.toBe("first fallback");
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "skip" }))
    ).resolves.toBe("second fallback");
    expect(family.doStreamCalls).toHaveLength(1);

    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    await expect(
      collectStream(streamText({ model: route("first"), prompt: "probe" }))
    ).resolves.toBe("family recovered");
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "shared recovery" })
      )
    ).resolves.toBe("family recovered");

    expect(family.doStreamCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    expect(
      route.getAdmissionSnapshot().every(({ inFlight }) => inFlight === 0)
    ).toBe(true);
    vi.useRealTimers();
  });

  it("allows only one concurrent family half-open probe across keys", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    let probeStarted = false;
    let resolveProbe:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const recovered = (): LanguageModelV4GenerateResult => ({
      content: [{ text: "family recovered", type: "text" }],
      finishReason,
      usage,
      warnings: [],
    });
    const family = new MockLanguageModelV4({
      doGenerate: () => {
        if (!healthy) {
          return Promise.reject(new Error("family unavailable"));
        }
        if (!probeStarted) {
          probeStarted = true;
          return new Promise((resolve) => {
            resolveProbe = resolve;
          });
        }
        return Promise.resolve(recovered());
      },
    });
    const firstFallback = okModel("first fallback");
    const secondFallback = okModel("second fallback");
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-concurrent-probe",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          firstFallback,
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          secondFallback,
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "outage" })
    ).resolves.toMatchObject({ text: "first fallback" });
    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));

    const probe = generateText({ model: route("first"), prompt: "probe" });
    await vi.waitFor(() => expect(family.doGenerateCalls).toHaveLength(2));
    await expect(
      generateText({ model: route("second"), prompt: "concurrent" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(family.doGenerateCalls).toHaveLength(2);
    expect(secondFallback.doGenerateCalls).toHaveLength(1);

    resolveProbe?.(recovered());
    await expect(probe).resolves.toMatchObject({ text: "family recovered" });
    await expect(
      generateText({ model: route("second"), prompt: "after recovery" })
    ).resolves.toMatchObject({ text: "family recovered" });

    expect(family.doGenerateCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    expect(
      route.getAdmissionSnapshot().every(({ inFlight }) => inFlight === 0)
    ).toBe(true);
    vi.useRealTimers();
  });

  it("holds one family probe lease until stream output is validated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    let probeStarted = false;
    let probeController:
      | ReadableStreamDefaultController<LanguageModelV4StreamPart>
      | undefined;
    const failedStream = errorPartStreamModel(new Error("family unavailable"));
    const recoveredStream = streamingModel(["family recovered"]);
    const family = new MockLanguageModelV4({
      doStream: (options) => {
        if (!healthy) {
          return failedStream.doStream(options);
        }
        if (!probeStarted) {
          probeStarted = true;
          return Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              start(controller) {
                probeController = controller;
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ id: "probe", type: "text-start" });
              },
            }),
          });
        }
        return recoveredStream.doStream(options);
      },
    });
    const firstFallback = streamingModel(["first fallback"]);
    const secondFallback = streamingModel(["second fallback"]);
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-concurrent-stream-probe",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          firstFallback,
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          secondFallback,
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "outage" }))
    ).resolves.toBe("first fallback");
    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));

    const probe = collectStream(
      streamText({ model: route("first"), prompt: "probe" })
    );
    await vi.waitFor(() => expect(family.doStreamCalls).toHaveLength(2));
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "concurrent" })
      )
    ).resolves.toBe("second fallback");
    expect(family.doStreamCalls).toHaveLength(2);
    expect(secondFallback.doStreamCalls).toHaveLength(1);

    probeController?.enqueue({
      delta: "family recovered",
      id: "probe",
      type: "text-delta",
    });
    probeController?.enqueue({ id: "probe", type: "text-end" });
    probeController?.enqueue({ type: "finish", finishReason, usage });
    probeController?.close();
    await expect(probe).resolves.toBe("family recovered");
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "after recovery" })
      )
    ).resolves.toBe("family recovered");

    expect(family.doStreamCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    expect(
      route.getAdmissionSnapshot().every(({ inFlight }) => inFlight === 0)
    ).toBe(true);
    vi.useRealTimers();
  });

  it("exponentially recools a family after a failed generate probe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const family = failingModel("family unavailable");
    const firstFallback = okModel("first fallback");
    const secondFallback = okModel("second fallback");
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-generate-recool",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          firstFallback,
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          secondFallback,
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "outage" })
    ).resolves.toMatchObject({ text: "first fallback" });
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    await expect(
      generateText({ model: route("first"), prompt: "failed probe" })
    ).resolves.toMatchObject({ text: "first fallback" });
    expect(family.doGenerateCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(2);

    vi.setSystemTime(new Date("2026-01-01T00:00:45.000Z"));
    await expect(
      generateText({ model: route("second"), prompt: "still cooling" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(family.doGenerateCalls).toHaveLength(2);

    vi.setSystemTime(new Date("2026-01-01T00:00:45.002Z"));
    await expect(
      generateText({ model: route("second"), prompt: "next probe" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(family.doGenerateCalls).toHaveLength(3);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    vi.useRealTimers();
  });

  it("exponentially recools a family after a failed stream probe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const family = errorPartStreamModel(new Error("family unavailable"));
    const firstFallback = streamingModel(["first fallback"]);
    const secondFallback = streamingModel(["second fallback"]);
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-stream-recool",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          firstFallback,
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          secondFallback,
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "outage" }))
    ).resolves.toBe("first fallback");
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    await expect(
      collectStream(
        streamText({ model: route("first"), prompt: "failed probe" })
      )
    ).resolves.toBe("first fallback");
    expect(family.doStreamCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(2);

    vi.setSystemTime(new Date("2026-01-01T00:00:45.000Z"));
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "still cooling" })
      )
    ).resolves.toBe("second fallback");
    expect(family.doStreamCalls).toHaveLength(2);

    vi.setSystemTime(new Date("2026-01-01T00:00:45.002Z"));
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "next probe" })
      )
    ).resolves.toBe("second fallback");
    expect(family.doStreamCalls).toHaveLength(3);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    vi.useRealTimers();
  });

  it("releases a cancelled family stream probe for a sibling key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    let probeStarted = false;
    let probeCancels = 0;
    const failedStream = errorPartStreamModel(new Error("family unavailable"));
    const recoveredStream = streamingModel(["family recovered"]);
    const family = new MockLanguageModelV4({
      doStream: (options) => {
        if (!healthy) {
          return failedStream.doStream(options);
        }
        if (!probeStarted) {
          probeStarted = true;
          return Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              cancel() {
                probeCancels += 1;
              },
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ id: "probe", type: "text-start" });
              },
            }),
          });
        }
        return recoveredStream.doStream(options);
      },
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-cancelled-stream-probe",
        retryBudget: true,
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["first fallback"]),
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["second fallback"]),
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "outage" }))
    ).resolves.toBe("first fallback");
    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const result = await asV4(route("first")).doStream(genOptions);
    const reader = result.stream.getReader();
    const pending = reader.read();
    await vi.waitFor(() => expect(family.doStreamCalls).toHaveLength(2));

    await reader.cancel("consumer stopped family probe");
    await pending;

    expect(probeCancels).toBe(1);
    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "sibling probe" })
      )
    ).resolves.toBe("family recovered");
    expect(family.doStreamCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    expect(
      route.getAdmissionSnapshot().every(({ inFlight }) => inFlight === 0)
    ).toBe(true);
    vi.useRealTimers();
  });

  it("releases a caller-aborted family generate probe for a sibling key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    let probeStarted = false;
    const recovered = (): LanguageModelV4GenerateResult => ({
      content: [{ text: "family recovered", type: "text" }],
      finishReason,
      usage,
      warnings: [],
    });
    const family = new MockLanguageModelV4({
      doGenerate: (options) => {
        if (!healthy) {
          return Promise.reject(new Error("family unavailable"));
        }
        if (!probeStarted) {
          probeStarted = true;
          return new Promise((_, reject) => {
            options.abortSignal?.addEventListener(
              "abort",
              () => reject(options.abortSignal?.reason),
              { once: true }
            );
          });
        }
        return Promise.resolve(recovered());
      },
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-aborted-generate-probe",
        retryBudget: true,
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          okModel("first fallback"),
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          okModel("second fallback"),
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "outage" })
    ).resolves.toMatchObject({ text: "first fallback" });
    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const caller = new AbortController();
    const reason = new Error("caller stopped family generate probe");
    const probe = generateText({
      abortSignal: caller.signal,
      model: route("first"),
      prompt: "probe",
    });
    const probeExpectation = expect(probe).rejects.toBe(reason);
    await vi.waitFor(() => expect(family.doGenerateCalls).toHaveLength(2));

    caller.abort(reason);
    await probeExpectation;

    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    await expect(
      generateText({ model: route("second"), prompt: "sibling probe" })
    ).resolves.toMatchObject({ text: "family recovered" });
    expect(family.doGenerateCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    vi.useRealTimers();
  });

  it("releases a caller-aborted family stream probe for a sibling key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    let probeStarted = false;
    const failedStream = errorPartStreamModel(new Error("family unavailable"));
    const recoveredStream = streamingModel(["family recovered"]);
    const family = new MockLanguageModelV4({
      doStream: (options) => {
        if (!healthy) {
          return failedStream.doStream(options);
        }
        if (!probeStarted) {
          probeStarted = true;
          return Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ id: "probe", type: "text-start" });
                options.abortSignal?.addEventListener(
                  "abort",
                  () => controller.error(options.abortSignal?.reason),
                  { once: true }
                );
              },
            }),
          });
        }
        return recoveredStream.doStream(options);
      },
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-aborted-stream-probe",
        retryBudget: true,
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["first fallback"]),
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["second fallback"]),
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "outage" }))
    ).resolves.toBe("first fallback");
    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const caller = new AbortController();
    const reason = new Error("caller stopped family stream probe");
    const result = await asV4(route("first")).doStream({
      ...genOptions,
      abortSignal: caller.signal,
    });
    const reader = result.stream.getReader();
    const pending = reader.read();
    const pendingExpectation = expect(pending).rejects.toBe(reason);
    await vi.waitFor(() => expect(family.doStreamCalls).toHaveLength(2));

    caller.abort(reason);
    await pendingExpectation;

    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "sibling probe" })
      )
    ).resolves.toBe("family recovered");
    expect(family.doStreamCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    vi.useRealTimers();
  });

  it("recools a family after a generate probe attempt timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let hang = false;
    const family = new MockLanguageModelV4({
      doGenerate: () =>
        hang
          ? new Promise<never>(() => undefined)
          : Promise.reject(new Error("family unavailable")),
    });
    const firstFallback = okModel("first fallback");
    const secondFallback = okModel("second fallback");
    const route = createRouter({
      fallback: {
        attemptTimeout: 10,
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-attempt-timeout",
        retryBudget: true,
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          firstFallback,
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          secondFallback,
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "outage" })
    ).resolves.toMatchObject({ text: "first fallback" });
    hang = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const probe = generateText({ model: route("first"), prompt: "probe" });
    await vi.advanceTimersByTimeAsync(10);
    await expect(probe).resolves.toMatchObject({ text: "first fallback" });

    expect(family.doGenerateCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(2);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 2,
    });

    await expect(
      generateText({ model: route("second"), prompt: "still cooling" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(family.doGenerateCalls).toHaveLength(2);
    vi.useRealTimers();
  });

  it("recools a family after a stream probe first-content timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let hang = false;
    const failedStream = errorPartStreamModel(new Error("family unavailable"));
    const family = new MockLanguageModelV4({
      doStream: (options) =>
        hang
          ? Promise.resolve({
              stream: new ReadableStream<LanguageModelV4StreamPart>(),
            })
          : failedStream.doStream(options),
    });
    const firstFallback = streamingModel(["first fallback"]);
    const secondFallback = streamingModel(["second fallback"]);
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        firstContentTimeout: 10,
        health: true,
        healthNamespace: "family-first-content-timeout",
        retryBudget: true,
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          firstFallback,
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          secondFallback,
        ],
      },
    });

    const initial = collectStream(
      streamText({ model: route("first"), prompt: "outage" })
    );
    await vi.runAllTimersAsync();
    await expect(initial).resolves.toBe("first fallback");
    hang = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const probe = collectStream(
      streamText({ model: route("first"), prompt: "probe" })
    );
    for (
      let turns = 0;
      turns < 20 && family.doStreamCalls.length < 2;
      turns++
    ) {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    }
    expect(family.doStreamCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10);
    await vi.runAllTimersAsync();
    await expect(probe).resolves.toBe("first fallback");

    expect(family.doStreamCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(2);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 2,
    });

    const sibling = collectStream(
      streamText({ model: route("second"), prompt: "still cooling" })
    );
    await vi.runAllTimersAsync();
    await expect(sibling).resolves.toBe("second fallback");
    expect(family.doStreamCalls).toHaveLength(2);
    vi.useRealTimers();
  });

  it("censors a family generate probe stopped by total timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let mode: "fail" | "hang" | "recover" = "fail";
    const recovered = (): LanguageModelV4GenerateResult => ({
      content: [{ text: "family recovered", type: "text" }],
      finishReason,
      usage,
      warnings: [],
    });
    const family = new MockLanguageModelV4({
      doGenerate: () => {
        if (mode === "fail") {
          return Promise.reject(new Error("family unavailable"));
        }
        return mode === "hang"
          ? new Promise<never>(() => undefined)
          : Promise.resolve(recovered());
      },
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-generate-total-timeout",
        retryBudget: true,
        totalTimeout: 10,
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          okModel("first fallback"),
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          okModel("second fallback"),
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "outage" })
    ).resolves.toMatchObject({ text: "first fallback" });
    mode = "hang";
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const probe = generateText({ model: route("first"), prompt: "probe" });
    const probeExpectation = expect(probe).rejects.toMatchObject({
      code: "total_timeout",
    });
    await vi.advanceTimersByTimeAsync(10);
    await probeExpectation;

    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    mode = "recover";
    await expect(
      generateText({ model: route("second"), prompt: "sibling probe" })
    ).resolves.toMatchObject({ text: "family recovered" });
    expect(family.doGenerateCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    vi.useRealTimers();
  });

  it("censors a family stream probe open stopped by total timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let mode: "fail" | "hang" | "recover" = "fail";
    const failedStream = errorPartStreamModel(new Error("family unavailable"));
    const recoveredStream = streamingModel(["family recovered"]);
    const family = new MockLanguageModelV4({
      doStream: (options) => {
        if (mode === "fail") {
          return failedStream.doStream(options);
        }
        return mode === "hang"
          ? new Promise<never>(() => undefined)
          : recoveredStream.doStream(options);
      },
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-stream-total-timeout",
        retryBudget: true,
        totalTimeout: 10,
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["first fallback"]),
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["second fallback"]),
        ],
      },
    });

    const initial = collectStream(
      streamText({ model: route("first"), prompt: "outage" })
    );
    await vi.runAllTimersAsync();
    await expect(initial).resolves.toBe("first fallback");
    mode = "hang";
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const probe = asV4(route("first")).doStream(genOptions);
    const probeExpectation = expect(probe).rejects.toMatchObject({
      code: "total_timeout",
    });
    await vi.advanceTimersByTimeAsync(10);
    await probeExpectation;

    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    mode = "recover";
    const sibling = collectStream(
      streamText({ model: route("second"), prompt: "sibling probe" })
    );
    await vi.runAllTimersAsync();
    await expect(sibling).resolves.toBe("family recovered");
    expect(family.doStreamCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    vi.useRealTimers();
  });

  it("does not claim a family probe when retry budget blocks the fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const familyError = new Error("family unavailable");
    let familyHealthy = false;
    const family = new MockLanguageModelV4({
      doGenerate: () =>
        familyHealthy
          ? Promise.resolve({
              content: [{ text: "family recovered", type: "text" }],
              finishReason,
              usage,
              warnings: [],
            })
          : Promise.reject(familyError),
    });
    const blocker = failingModel("blocked logical primary failed");
    const route = createRouter({
      fallback: {
        classifyFailure: (error) => ({
          retryable: true,
          scope: error === familyError ? "provider-family" : "transient",
        }),
        health: true,
        healthNamespace: "family-budget-probe",
        retryBudget: {
          minSamples: 1,
          recoveryFailureRate: 0.4,
          tripFailureRate: 1,
        },
      },
      models: {
        seed: [
          {
            healthKey: "family-key-seed",
            model: family,
            providerFamily: "shared-family",
          },
          okModel("seed fallback"),
        ],
        blocked: [
          blocker,
          {
            healthKey: "family-key-blocked",
            model: family,
            providerFamily: "shared-family",
          },
        ],
        probe: [
          {
            healthKey: "family-key-probe",
            model: family,
            providerFamily: "shared-family",
          },
        ],
      },
    });

    await expect(
      generateText({ model: route("seed"), prompt: "seed outage" })
    ).resolves.toMatchObject({ text: "seed fallback" });
    familyHealthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const blocked = asV4(route("blocked"));
    const budget = Reflect.get(blocked, "retryBudget") as {
      observe: (success: boolean) => void;
    };
    budget.observe(false);

    await expect(blocked.doGenerate(genOptions)).rejects.toThrow(
      "blocked logical primary failed"
    );
    expect(blocker.doGenerateCalls).toHaveLength(1);
    expect(family.doGenerateCalls).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    await expect(
      generateText({ model: route("probe"), prompt: "healthy budget probe" })
    ).resolves.toMatchObject({ text: "family recovered" });
    expect(family.doGenerateCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().filter(({ key }) => key.includes(":family:"))
    ).toEqual([]);
    vi.useRealTimers();
  });

  it("does not claim a stream family probe when retry budget blocks fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const familyError = new Error("family unavailable");
    const blockerError = new Error("blocked stream primary failed");
    let familyHealthy = false;
    const failedFamily = errorPartStreamModel(familyError);
    const recoveredFamily = streamingModel(["family recovered"]);
    const family = new MockLanguageModelV4({
      doStream: (options) =>
        familyHealthy
          ? recoveredFamily.doStream(options)
          : failedFamily.doStream(options),
    });
    const blocker = errorPartStreamModel(blockerError);
    const route = createRouter({
      fallback: {
        classifyFailure: (error) => ({
          retryable: true,
          scope: error === familyError ? "provider-family" : "transient",
        }),
        health: true,
        healthNamespace: "family-stream-budget-probe",
        retryBudget: {
          minSamples: 1,
          recoveryFailureRate: 0.4,
          tripFailureRate: 1,
        },
      },
      models: {
        seed: [
          {
            healthKey: "family-key-seed",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["seed fallback"]),
        ],
        blocked: [
          blocker,
          {
            healthKey: "family-key-blocked",
            model: family,
            providerFamily: "shared-family",
          },
        ],
        probe: [
          {
            healthKey: "family-key-probe",
            model: family,
            providerFamily: "shared-family",
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("seed"), prompt: "seed outage" }))
    ).resolves.toBe("seed fallback");
    familyHealthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const blocked = asV4(route("blocked"));
    const budget = Reflect.get(blocked, "retryBudget") as {
      observe: (success: boolean) => void;
    };
    budget.observe(false);

    await expect(
      collectStream(streamText({ model: blocked, prompt: "blocked" }))
    ).rejects.toBe(blockerError);
    expect(blocker.doStreamCalls).toHaveLength(1);
    expect(family.doStreamCalls).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    await expect(
      collectStream(streamText({ model: route("probe"), prompt: "probe" }))
    ).resolves.toBe("family recovered");
    expect(family.doStreamCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().filter(({ key }) => key.includes(":family:"))
    ).toEqual([]);
    vi.useRealTimers();
  });

  it("does not claim a family probe when maxAttempts blocks the fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const familyError = new Error("family unavailable");
    let familyHealthy = false;
    const family = new MockLanguageModelV4({
      doGenerate: () =>
        familyHealthy
          ? Promise.resolve({
              content: [{ text: "family recovered", type: "text" }],
              finishReason,
              usage,
              warnings: [],
            })
          : Promise.reject(familyError),
    });
    const blocker = failingModel("blocked logical primary failed");
    const events: Array<{
      attempt?: number;
      index: number;
      outcome: string;
    }> = [];
    const route = createRouter({
      fallback: {
        classifyFailure: (error) => ({
          retryable: true,
          scope: error === familyError ? "provider-family" : "transient",
        }),
        health: true,
        healthNamespace: "family-max-attempts-probe",
        maxAttempts: 1,
      },
      models: {
        blocked: [
          blocker,
          {
            healthKey: "family-key-blocked",
            model: family,
            providerFamily: "shared-family",
          },
        ],
        probe: [
          {
            healthKey: "family-key-probe",
            model: family,
            providerFamily: "shared-family",
          },
        ],
        seed: [
          {
            healthKey: "family-key-seed",
            model: family,
            providerFamily: "shared-family",
          },
        ],
      },
      onAttempt: ({ attempt, index, outcome }) =>
        events.push({ attempt, index, outcome }),
    });

    await expect(
      generateText({ model: route("seed"), prompt: "seed outage" })
    ).rejects.toBe(familyError);
    events.length = 0;
    familyHealthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));

    await expect(
      generateText({ model: route("blocked"), prompt: "blocked" })
    ).rejects.toThrow("blocked logical primary failed");
    expect(blocker.doGenerateCalls).toHaveLength(1);
    expect(family.doGenerateCalls).toHaveLength(1);
    expect(events).toEqual([
      { attempt: 1, index: 0, outcome: "failure" },
      { attempt: undefined, index: 1, outcome: "skipped" },
    ]);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    await expect(
      generateText({ model: route("probe"), prompt: "probe" })
    ).resolves.toMatchObject({ text: "family recovered" });
    expect(family.doGenerateCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().filter(({ key }) => key.includes(":family:"))
    ).toEqual([]);
    vi.useRealTimers();
  });

  it("does not claim a stream family probe when maxAttempts blocks fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const familyError = new Error("family unavailable");
    const blockerError = new Error("blocked stream primary failed");
    let familyHealthy = false;
    const failedFamily = errorPartStreamModel(familyError);
    const recoveredFamily = streamingModel(["family recovered"]);
    const family = new MockLanguageModelV4({
      doStream: (options) =>
        familyHealthy
          ? recoveredFamily.doStream(options)
          : failedFamily.doStream(options),
    });
    const blocker = readErrorStreamModel(blockerError, "partial");
    const events: Array<{
      attempt?: number;
      index: number;
      outcome: string;
    }> = [];
    const route = createRouter({
      fallback: {
        classifyFailure: (error) => ({
          retryable: true,
          scope: error === familyError ? "provider-family" : "transient",
        }),
        health: true,
        healthNamespace: "family-stream-max-attempts-probe",
        maxAttempts: 1,
        retryAfterOutput: true,
      },
      models: {
        blocked: [
          blocker,
          {
            healthKey: "family-key-blocked",
            model: family,
            providerFamily: "shared-family",
          },
        ],
        probe: [
          {
            healthKey: "family-key-probe",
            model: family,
            providerFamily: "shared-family",
          },
        ],
        seed: [
          {
            healthKey: "family-key-seed",
            model: family,
            providerFamily: "shared-family",
          },
        ],
      },
      onAttempt: ({ attempt, index, outcome }) =>
        events.push({ attempt, index, outcome }),
    });

    await expect(
      collectStream(streamText({ model: route("seed"), prompt: "seed outage" }))
    ).rejects.toBe(familyError);
    events.length = 0;
    familyHealthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));

    const blocked = await asV4(route("blocked")).doStream(genOptions);
    const { error: blockedError, text: partial } = await collectRawStream(
      blocked.stream
    );
    expect(partial).toBe("partial");
    expect(blockedError).toBe(blockerError);
    expect(blocker.doStreamCalls).toHaveLength(1);
    expect(family.doStreamCalls).toHaveLength(1);
    expect(events).toEqual([
      { attempt: 1, index: 0, outcome: "failure" },
      { attempt: undefined, index: 1, outcome: "skipped" },
    ]);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    await expect(
      collectStream(streamText({ model: route("probe"), prompt: "probe" }))
    ).resolves.toBe("family recovered");
    expect(family.doStreamCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().filter(({ key }) => key.includes(":family:"))
    ).toEqual([]);
    vi.useRealTimers();
  });

  it("does not claim a credential probe when maxAttempts blocks fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const credentialError = new Error("credential unavailable");
    let credentialHealthy = false;
    const credential = new MockLanguageModelV4({
      doGenerate: () =>
        credentialHealthy
          ? Promise.resolve({
              content: [{ text: "credential recovered", type: "text" }],
              finishReason,
              usage,
              warnings: [],
            })
          : Promise.reject(credentialError),
    });
    const blocker = failingModel("blocked logical primary failed");
    const route = createRouter({
      fallback: {
        classifyFailure: (error) => ({
          retryable: true,
          scope: error === credentialError ? "credential" : "transient",
        }),
        health: true,
        healthNamespace: "credential-max-attempts-probe",
        maxAttempts: 1,
      },
      models: {
        blocked: [
          blocker,
          { healthKey: "shared-credential", model: credential },
        ],
        probe: [{ healthKey: "shared-credential", model: credential }],
        seed: [{ healthKey: "shared-credential", model: credential }],
      },
    });

    await expect(
      generateText({ model: route("seed"), prompt: "seed outage" })
    ).rejects.toBe(credentialError);
    credentialHealthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:01:00.001Z"));

    await expect(
      generateText({ model: route("blocked"), prompt: "blocked" })
    ).rejects.toThrow("blocked logical primary failed");
    expect(blocker.doGenerateCalls).toHaveLength(1);
    expect(credential.doGenerateCalls).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    await expect(
      generateText({ model: route("probe"), prompt: "probe" })
    ).resolves.toMatchObject({ text: "credential recovered" });
    expect(credential.doGenerateCalls).toHaveLength(2);
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toEqual([]);
    vi.useRealTimers();
  });

  it("does not claim a stream credential probe when maxAttempts blocks fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const credentialError = new Error("credential unavailable");
    const blockerError = new Error("blocked stream primary failed");
    let credentialHealthy = false;
    const failedCredential = errorPartStreamModel(credentialError);
    const recoveredCredential = streamingModel(["credential recovered"]);
    const credential = new MockLanguageModelV4({
      doStream: (options) =>
        credentialHealthy
          ? recoveredCredential.doStream(options)
          : failedCredential.doStream(options),
    });
    const blocker = errorPartStreamModel(blockerError);
    const route = createRouter({
      fallback: {
        classifyFailure: (error) => ({
          retryable: true,
          scope: error === credentialError ? "credential" : "transient",
        }),
        health: true,
        healthNamespace: "credential-stream-max-attempts-probe",
        maxAttempts: 1,
      },
      models: {
        blocked: [
          blocker,
          { healthKey: "shared-credential", model: credential },
        ],
        probe: [{ healthKey: "shared-credential", model: credential }],
        seed: [{ healthKey: "shared-credential", model: credential }],
      },
    });

    await expect(
      collectStream(streamText({ model: route("seed"), prompt: "seed outage" }))
    ).rejects.toBe(credentialError);
    credentialHealthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:01:00.001Z"));

    await expect(
      collectStream(streamText({ model: route("blocked"), prompt: "blocked" }))
    ).rejects.toBe(blockerError);
    expect(blocker.doStreamCalls).toHaveLength(1);
    expect(credential.doStreamCalls).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    await expect(
      collectStream(streamText({ model: route("probe"), prompt: "probe" }))
    ).resolves.toBe("credential recovered");
    expect(credential.doStreamCalls).toHaveLength(2);
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toEqual([]);
    vi.useRealTimers();
  });

  it("keeps credential 429 cooldown isolated within one provider family", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const limited = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          Object.assign(new Error("first key limited"), {
            responseHeaders: {
              "x-ratelimit-reset-requests": "90s",
              "x-ratelimit-reset-tokens": "120s",
            },
            statusCode: 429,
          })
        ),
    });
    const sibling = okModel("sibling key");
    const route = createRouter({
      fallback: { health: true, healthNamespace: "family-credentials" },
      models: {
        chat: [
          {
            healthKey: "key-a",
            model: limited,
            providerFamily: "friendli",
          },
          {
            healthKey: "key-b",
            model: sibling,
            providerFamily: "friendli",
          },
        ],
      },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "first" })
    ).resolves.toMatchObject({ text: "sibling key" });
    await expect(
      generateText({ model: route("chat"), prompt: "second" })
    ).resolves.toMatchObject({ text: "sibling key" });
    expect(limited.doGenerateCalls).toHaveLength(1);
    expect(sibling.doGenerateCalls).toHaveLength(2);
    expect(
      route
        .getHealthSnapshot("chat")
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot("chat")
        .some(({ key }) => key.includes(":family:"))
    ).toBe(false);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      generateText({ model: route("chat"), prompt: "probe" })
    ).resolves.toMatchObject({ text: "sibling key" });
    expect(limited.doGenerateCalls).toHaveLength(2);
    expect(sibling.doGenerateCalls).toHaveLength(3);
    vi.useRealTimers();
  });

  it("keeps stream credential cooldown isolated within one provider family", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = Object.assign(new Error("first stream key limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const limited = errorPartStreamModel(failure);
    const sibling = streamingModel(["sibling stream key"]);
    const route = createRouter({
      fallback: { health: true, healthNamespace: "family-stream-credentials" },
      models: {
        chat: [
          {
            healthKey: "key-a",
            model: limited,
            providerFamily: "friendli",
          },
          {
            healthKey: "key-b",
            model: sibling,
            providerFamily: "friendli",
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "first" }))
    ).resolves.toBe("sibling stream key");
    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "second" }))
    ).resolves.toBe("sibling stream key");
    expect(limited.doStreamCalls).toHaveLength(1);
    expect(sibling.doStreamCalls).toHaveLength(2);
    expect(
      route
        .getHealthSnapshot("chat")
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot("chat")
        .some(({ key }) => key.includes(":family:"))
    ).toBe(false);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "probe" }))
    ).resolves.toBe("sibling stream key");
    expect(limited.doStreamCalls).toHaveLength(2);
    expect(sibling.doStreamCalls).toHaveLength(3);
    vi.useRealTimers();
  });

  it("lets a newer cross-model success recover shared credential health", async () => {
    let rejectPrimary: ((error: unknown) => void) | undefined;
    let resolveRecovery: (() => void) | undefined;
    const primary = new MockLanguageModelV4({
      doGenerate: () => {
        if (primary.doGenerateCalls.length > 1) {
          return Promise.resolve({
            content: [{ text: "primary recovered", type: "text" }],
            finishReason,
            usage,
            warnings: [],
          });
        }
        return new Promise((_, reject) => {
          rejectPrimary = reject;
        });
      },
    });
    const recovery = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          resolveRecovery = () =>
            resolve({
              content: [{ text: "recovery", type: "text" }],
              finishReason,
              usage,
              warnings: [],
            });
        }),
    });
    const route = createRouter({
      fallback: { health: true, healthNamespace: "recovery" },
      models: {
        failing: [
          { healthKey: "shared-key", model: primary },
          { healthKey: "fallback", model: okModel("fallback") },
        ],
        recovering: [{ healthKey: "shared-key", model: recovery }],
      },
    });

    const failedRequest = generateText({
      model: route("failing"),
      prompt: "fail",
    });
    await vi.waitFor(() => expect(rejectPrimary).toBeTypeOf("function"));
    const recoveryRequest = generateText({
      model: route("recovering"),
      prompt: "recover",
    });
    await vi.waitFor(() => expect(resolveRecovery).toBeTypeOf("function"));

    rejectPrimary?.(
      Object.assign(new Error("credential limited"), { statusCode: 429 })
    );
    await expect(failedRequest).resolves.toMatchObject({ text: "fallback" });
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(1);

    resolveRecovery?.();
    await expect(recoveryRequest).resolves.toMatchObject({ text: "recovery" });
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(0);

    await expect(
      generateText({ model: route("failing"), prompt: "again" })
    ).resolves.toMatchObject({ text: "primary recovered" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("does not let an older same-ms cross-model success erase a newer failure", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      let rejectPrimary: ((error: unknown) => void) | undefined;
      let resolveRecovery: (() => void) | undefined;
      const primary = new MockLanguageModelV4({
        doGenerate: () =>
          new Promise((_, reject) => {
            rejectPrimary = reject;
          }),
      });
      const recovery = new MockLanguageModelV4({
        doGenerate: () =>
          new Promise((resolve) => {
            resolveRecovery = () =>
              resolve({
                content: [{ text: "stale recovery", type: "text" }],
                finishReason,
                usage,
                warnings: [],
              });
          }),
      });
      const route = createRouter({
        fallback: { health: true, healthNamespace: "stale-recovery" },
        models: {
          failing: [
            { healthKey: "shared-key", model: primary },
            { healthKey: "fallback", model: okModel("fallback") },
          ],
          recovering: [{ healthKey: "shared-key", model: recovery }],
        },
      });

      const recoveryRequest = generateText({
        model: route("recovering"),
        prompt: "older",
      });
      await vi.waitFor(() => expect(resolveRecovery).toBeTypeOf("function"));
      const failedRequest = generateText({
        model: route("failing"),
        prompt: "newer",
      });
      await vi.waitFor(() => expect(rejectPrimary).toBeTypeOf("function"));

      rejectPrimary?.(
        Object.assign(new Error("credential limited"), { statusCode: 429 })
      );
      await expect(failedRequest).resolves.toMatchObject({ text: "fallback" });
      resolveRecovery?.();
      await expect(recoveryRequest).resolves.toMatchObject({
        text: "stale recovery",
      });

      expect(
        route
          .getHealthSnapshot()
          .filter(({ key }) => key.includes(":credential:"))
      ).toHaveLength(1);
      await expect(
        generateText({ model: route("failing"), prompt: "again" })
      ).resolves.toMatchObject({ text: "fallback" });
      expect(primary.doGenerateCalls).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("orders same-ms attempts across routers sharing one health store", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      const store = new MemoryRouterHealthStore();
      let resolveRecovery: (() => void) | undefined;
      let rejectFailure: ((error: unknown) => void) | undefined;
      const recovery = new MockLanguageModelV4({
        doGenerate: () =>
          new Promise((resolve) => {
            resolveRecovery = () =>
              resolve({
                content: [{ text: "stale recovery", type: "text" }],
                finishReason,
                usage,
                warnings: [],
              });
          }),
      });
      const failing = new MockLanguageModelV4({
        doGenerate: () =>
          new Promise((_, reject) => {
            rejectFailure = reject;
          }),
      });
      const sharedFallback = {
        health: true,
        healthNamespace: "cross-router",
        healthStore: store,
      } as const;
      const recoveryRoute = createRouter({
        fallback: sharedFallback,
        models: { chat: [{ healthKey: "shared-key", model: recovery }] },
      });
      const failingRoute = createRouter({
        fallback: sharedFallback,
        models: {
          chat: [
            { healthKey: "shared-key", model: failing },
            { healthKey: "fallback", model: okModel("fallback") },
          ],
        },
      });

      const recoveryRequest = generateText({
        model: recoveryRoute("chat"),
        prompt: "older",
      });
      await vi.waitFor(() => expect(resolveRecovery).toBeTypeOf("function"));
      const failedRequest = generateText({
        model: failingRoute("chat"),
        prompt: "newer",
      });
      await vi.waitFor(() => expect(rejectFailure).toBeTypeOf("function"));

      rejectFailure?.(
        Object.assign(new Error("credential limited"), { statusCode: 429 })
      );
      await expect(failedRequest).resolves.toMatchObject({ text: "fallback" });
      resolveRecovery?.();
      await expect(recoveryRequest).resolves.toMatchObject({
        text: "stale recovery",
      });

      expect(
        failingRoute
          .getHealthSnapshot()
          .filter(({ key }) => key.includes(":credential:"))
      ).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("does not let an older stream finish erase a newer cross-model failure", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      let finishRecovery: (() => void) | undefined;
      const recovery = new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ id: "1", type: "text-start" });
              controller.enqueue({
                delta: "older stream",
                id: "1",
                type: "text-delta",
              });
              controller.enqueue({ id: "1", type: "text-end" });
              finishRecovery = () => {
                controller.enqueue({ type: "finish", finishReason, usage });
                controller.close();
              };
            },
          }),
        }),
      });
      const failing = failingModelStatus(429, "credential limited");
      const route = createRouter({
        fallback: { health: true, healthNamespace: "stream-recovery" },
        models: {
          failing: [
            { healthKey: "shared-key", model: failing },
            { healthKey: "fallback", model: okModel("fallback") },
          ],
          recovering: [{ healthKey: "shared-key", model: recovery }],
        },
      });

      const recoveryRequest = collectStream(
        streamText({ model: route("recovering"), prompt: "older" })
      );
      await vi.waitFor(() => expect(finishRecovery).toBeTypeOf("function"));
      await expect(
        generateText({ model: route("failing"), prompt: "newer" })
      ).resolves.toMatchObject({ text: "fallback" });

      finishRecovery?.();
      await expect(recoveryRequest).resolves.toBe("older stream");
      expect(
        route
          .getHealthSnapshot()
          .filter(({ key }) => key.includes(":credential:"))
      ).toHaveLength(1);
      await expect(
        generateText({ model: route("failing"), prompt: "again" })
      ).resolves.toMatchObject({ text: "fallback" });
      expect(failing.doGenerateCalls).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("lets a newer stream finish recover an older cross-model failure", async () => {
    let rejectPrimary: ((error: unknown) => void) | undefined;
    let finishRecovery: (() => void) | undefined;
    const primary = new MockLanguageModelV4({
      doGenerate: () => {
        if (primary.doGenerateCalls.length > 1) {
          return Promise.resolve({
            content: [{ text: "primary recovered", type: "text" }],
            finishReason,
            usage,
            warnings: [],
          });
        }
        return new Promise((_, reject) => {
          rejectPrimary = reject;
        });
      },
    });
    const recovery = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ id: "1", type: "text-start" });
            controller.enqueue({
              delta: "newer stream",
              id: "1",
              type: "text-delta",
            });
            controller.enqueue({ id: "1", type: "text-end" });
            finishRecovery = () => {
              controller.enqueue({ type: "finish", finishReason, usage });
              controller.close();
            };
          },
        }),
      }),
    });
    const route = createRouter({
      fallback: { health: true, healthNamespace: "new-stream-recovery" },
      models: {
        failing: [
          { healthKey: "shared-key", model: primary },
          { healthKey: "fallback", model: okModel("fallback") },
        ],
        recovering: [{ healthKey: "shared-key", model: recovery }],
      },
    });

    const failedRequest = generateText({
      model: route("failing"),
      prompt: "older",
    });
    await vi.waitFor(() => expect(rejectPrimary).toBeTypeOf("function"));
    const recoveryRequest = collectStream(
      streamText({ model: route("recovering"), prompt: "newer" })
    );
    await vi.waitFor(() => expect(finishRecovery).toBeTypeOf("function"));

    rejectPrimary?.(
      Object.assign(new Error("credential limited"), { statusCode: 429 })
    );
    await expect(failedRequest).resolves.toMatchObject({ text: "fallback" });
    finishRecovery?.();
    await expect(recoveryRequest).resolves.toBe("newer stream");

    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(0);
    await expect(
      generateText({ model: route("failing"), prompt: "again" })
    ).resolves.toMatchObject({ text: "primary recovered" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("does not let an older cancelled stream recover a newer shared failure", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      let upstreamCancels = 0;
      const recovery = new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            cancel() {
              upstreamCancels += 1;
            },
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ id: "1", type: "text-start" });
              controller.enqueue({
                delta: "partial",
                id: "1",
                type: "text-delta",
              });
            },
          }),
        }),
      });
      const failing = failingModelStatus(429, "credential limited");
      const route = createRouter({
        fallback: { health: true, healthNamespace: "cancel-recovery" },
        models: {
          failing: [
            { healthKey: "shared-key", model: failing },
            { healthKey: "fallback", model: okModel("fallback") },
          ],
          recovering: [{ healthKey: "shared-key", model: recovery }],
        },
      });

      const result = await asV4(route("recovering")).doStream(genOptions);
      const reader = result.stream.getReader();
      expect((await reader.read()).value?.type).toBe("stream-start");
      expect((await reader.read()).value?.type).toBe("text-start");
      expect((await reader.read()).value?.type).toBe("text-delta");

      await expect(
        generateText({ model: route("failing"), prompt: "newer" })
      ).resolves.toMatchObject({ text: "fallback" });
      await reader.cancel("consumer stopped");

      expect(upstreamCancels).toBe(1);
      expect(route.getAdmissionSnapshot("recovering")[0].inFlight).toBe(0);
      expect(
        route
          .getHealthSnapshot()
          .filter(({ key }) => key.includes(":credential:"))
      ).toHaveLength(1);
      await expect(
        generateText({ model: route("failing"), prompt: "again" })
      ).resolves.toMatchObject({ text: "fallback" });
      expect(failing.doGenerateCalls).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("releases a cancelled half-open stream probe immediately", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let cancels = 0;
    const openStream = () =>
      new ReadableStream<LanguageModelV4StreamPart>({
        cancel() {
          cancels += 1;
        },
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ id: "1", type: "text-start" });
          controller.enqueue({
            delta: "probe",
            id: "1",
            type: "text-delta",
          });
        },
      });
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(Object.assign(new Error("down"), { statusCode: 503 })),
      doStream: async () => ({ stream: openStream() }),
    });
    const fallbackStream = streamingModel(["fallback"]);
    const fallback = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ text: "fallback", type: "text" }],
        finishReason,
        usage,
        warnings: [],
      }),
      doStream: (options) => fallbackStream.doStream(options),
    });
    const route = createRouter({
      fallback: { health: true },
      models: { chat: [primary, fallback] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "cool" })
    ).resolves.toMatchObject({ text: "fallback" });
    vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));

    const first = await asV4(route("chat")).doStream(genOptions);
    const firstReader = first.stream.getReader();
    await firstReader.read();
    await firstReader.read();
    await firstReader.read();
    expect(
      route
        .getHealthSnapshot("chat")
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(true);
    await firstReader.cancel("consumer stopped");
    expect(
      route
        .getHealthSnapshot("chat")
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    const second = await asV4(route("chat")).doStream(genOptions);
    await second.stream.cancel("second consumer stopped");
    expect(primary.doStreamCalls).toHaveLength(2);
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
    expect(cancels).toBe(2);
  });

  it("does not collide when namespace and logical-id segment boundaries differ", async () => {
    const store = new MemoryRouterHealthStore();
    const primary = failingModel("down");
    const secondary = okModel("ok");
    const first = createRouter({
      fallback: { health: true, healthNamespace: "a", healthStore: store },
      models: { "b:c": [primary, secondary] },
    });
    const second = createRouter({
      fallback: { health: true, healthNamespace: "a:b", healthStore: store },
      models: { c: [primary, secondary] },
    });

    await generateText({ model: first("b:c"), prompt: "one" });
    await generateText({ model: second("c"), prompt: "two" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("shares credential health across logical models in one explicit namespace", async () => {
    const store = new MemoryRouterHealthStore();
    const limited = failingModelStatus(429, "credential limited");
    const firstFallback = okModel("first fallback");
    const secondFallback = okModel("second fallback");
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "production",
        healthStore: store,
      },
      models: {
        first: [
          { model: limited, healthKey: "shared-key" },
          { model: firstFallback, healthKey: "first-fallback" },
        ],
        second: [
          { model: limited, healthKey: "shared-key" },
          { model: secondFallback, healthKey: "second-fallback" },
        ],
      },
    });

    await generateText({ model: route("first"), prompt: "one" });
    await generateText({ model: route("second"), prompt: "two" });

    expect(limited.doGenerateCalls).toHaveLength(1);
    expect(secondFallback.doGenerateCalls).toHaveLength(1);
    const keys = route.getHealthSnapshot().map(({ key }) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((key) => key.includes("shared-key"))).toBe(false);
    expect(keys.some((key) => key.includes(":credential:#"))).toBe(true);
  });

  it("shares the longest credential quota reset until it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const limited = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          Object.assign(new Error("credential limited"), {
            responseHeaders: {
              "x-ratelimit-reset-requests": "90s",
              "x-ratelimit-reset-tokens": "120s",
            },
            statusCode: 429,
          })
        ),
    });
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "quota-reset",
      },
      models: {
        first: [
          { healthKey: "shared-key", model: limited },
          { healthKey: "first-fallback", model: okModel("first fallback") },
        ],
        second: [
          { healthKey: "shared-key", model: limited },
          { healthKey: "second-fallback", model: okModel("second fallback") },
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "initial" })
    ).resolves.toMatchObject({ text: "first fallback" });
    await expect(
      generateText({ model: route("second"), prompt: "shared cooldown" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(limited.doGenerateCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      generateText({ model: route("second"), prompt: "still cooling" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(limited.doGenerateCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      generateText({ model: route("first"), prompt: "probe after reset" })
    ).resolves.toMatchObject({ text: "first fallback" });
    expect(limited.doGenerateCalls).toHaveLength(2);
  });

  it("shares the longest stream-open quota reset until it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const limited = new MockLanguageModelV4({
      doStream: () =>
        Promise.reject(
          Object.assign(new Error("stream credential limited"), {
            responseHeaders: {
              "x-ratelimit-reset-requests": "90s",
              "x-ratelimit-reset-tokens": "120s",
            },
            statusCode: 429,
          })
        ),
    });
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "stream-quota-reset",
      },
      models: {
        first: [
          { healthKey: "shared-key", model: limited },
          {
            healthKey: "first-fallback",
            model: streamingModel(["first fallback"]),
          },
        ],
        second: [
          { healthKey: "shared-key", model: limited },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second fallback"]),
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "initial" }))
    ).resolves.toBe("first fallback");
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "shared cooldown" })
      )
    ).resolves.toBe("second fallback");
    expect(limited.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "still cooling" })
      )
    ).resolves.toBe("second fallback");
    expect(limited.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(
        streamText({ model: route("first"), prompt: "probe after reset" })
      )
    ).resolves.toBe("first fallback");
    expect(limited.doStreamCalls).toHaveLength(2);
  });

  it("shares wrapped credential-cause health across logical models", async () => {
    const wrapped = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          Object.assign(new Error("gateway request failed"), {
            cause: Object.assign(new Error("credential limited"), {
              responseHeaders: { "retry-after-ms": "125" },
              statusCode: 429,
            }),
          })
        ),
    });
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "production",
      },
      models: {
        first: [
          { healthKey: "shared-key", model: wrapped },
          { healthKey: "first-fallback", model: okModel("first fallback") },
        ],
        second: [
          { healthKey: "shared-key", model: wrapped },
          { healthKey: "second-fallback", model: okModel("second fallback") },
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "one" })
    ).resolves.toMatchObject({ text: "first fallback" });
    await expect(
      generateText({ model: route("second"), prompt: "two" })
    ).resolves.toMatchObject({ text: "second fallback" });

    expect(wrapped.doGenerateCalls).toHaveLength(1);
    const records = route
      .getHealthSnapshot()
      .filter(({ key }) => key.includes(":credential:"));
    expect(records).toHaveLength(1);
    expect(records[0].record.lastStatus).toBe(429);
  });

  it("shares wrapped stream credential-cause health across logical models", async () => {
    const wrappedFailure = Object.assign(new Error("gateway stream failed"), {
      cause: Object.assign(new Error("credential limited"), {
        responseHeaders: { "retry-after-ms": "125" },
        statusCode: 429,
      }),
    });
    const wrapped = errorPartStreamModel(wrappedFailure);
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "production-stream",
      },
      models: {
        first: [
          { healthKey: "shared-key", model: wrapped },
          {
            healthKey: "first-fallback",
            model: streamingModel(["first fallback"]),
          },
        ],
        second: [
          { healthKey: "shared-key", model: wrapped },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second fallback"]),
          },
        ],
      },
    });

    expect(
      await collectStream(streamText({ model: route("first"), prompt: "one" }))
    ).toBe("first fallback");
    expect(
      await collectStream(streamText({ model: route("second"), prompt: "two" }))
    ).toBe("second fallback");

    expect(wrapped.doStreamCalls).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(1);
  });

  it("does not share model-specific WAF cooldowns across logical models", async () => {
    const blocked = failingModelStatus(403, "upstream_waf_blocked");
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "production",
      },
      models: {
        first: [
          { model: blocked, healthKey: "shared-key" },
          { model: okModel("first fallback"), healthKey: "first-fallback" },
        ],
        second: [
          { model: blocked, healthKey: "shared-key" },
          { model: okModel("second fallback"), healthKey: "second-fallback" },
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "one" })
    ).resolves.toMatchObject({ text: "first fallback" });
    await expect(
      generateText({ model: route("second"), prompt: "two" })
    ).resolves.toMatchObject({ text: "second fallback" });

    expect(blocked.doGenerateCalls).toHaveLength(2);
    const keys = route.getHealthSnapshot().map(({ key }) => key);
    expect(keys.filter((key) => key.includes(":unit:")).length).toBe(2);
    expect(keys.some((key) => key.includes(":credential:"))).toBe(false);
  });

  it("uses a monotonic token when attempts start in the same millisecond", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      const route = createRouter({
        fallback: { health: true },
        models: {
          chat: [
            { model: failingModelStatus(429), healthKey: "one" },
            { model: failingModelStatus(429), healthKey: "two" },
            { model: okModel("ok"), healthKey: "three" },
          ],
        },
      });
      await generateText({ model: route("chat"), prompt: "same clock" });
      const tokens = route
        .getHealthSnapshot("chat")
        .map(({ record }) => record.lastFailureAt)
        .filter((value) => value !== undefined);

      expect(new Set(tokens).size).toBe(2);
      expect(tokens.every((token) => typeof token === "string")).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("rolls the logical millisecond when the fixed-width ordering counter fills", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const routed = asV4(
        createRouter({ models: { chat: [okModel()] } })("chat")
      ) as unknown as {
        nextOrderingToken(): string;
        ordering: { lastOrderingMs: number; orderingCounter: number };
      };
      routed.ordering.lastOrderingMs = 2000;
      routed.ordering.orderingCounter = 999_999;

      const first = routed.nextOrderingToken().split(":");
      const second = routed.nextOrderingToken().split(":");
      expect(first[1]).toBe("0000000002001");
      expect(first[3]).toBe("000000");
      expect(second[1]).toBe("0000000002001");
      expect(second[3]).toBe("000001");
    } finally {
      now.mockRestore();
    }
  });

  it("keeps ordering tokens valid when the wall clock is hostile", () => {
    const routed = asV4(
      createRouter({ models: { chat: [okModel()] } })("chat")
    ) as unknown as {
      nextOrderingToken(): string;
      ordering: { lastOrderingMs: number; orderingCounter: number };
    };
    routed.ordering.lastOrderingMs = 2000;
    routed.ordering.orderingCounter = 0;
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValueOnce(Number.MAX_VALUE);
      now.mockReturnValueOnce(Number.MAX_SAFE_INTEGER);
      now.mockReturnValueOnce(1.5);
      now.mockImplementationOnce(() => {
        throw new Error("clock unavailable");
      });

      const tokens = [
        routed.nextOrderingToken(),
        routed.nextOrderingToken(),
        routed.nextOrderingToken(),
        routed.nextOrderingToken(),
      ];

      expect(tokens.map((token) => token.split(":"))).toEqual([
        ["v1", "0000000002000", expect.any(String), "000001"],
        ["v1", "0000000002000", expect.any(String), "000002"],
        ["v1", "0000000002000", expect.any(String), "000003"],
        ["v1", "0000000002000", expect.any(String), "000004"],
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("never falls back after a caller abort", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: (options) =>
        new Promise((_, reject) => {
          options.abortSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        }),
    });
    const secondary = okModel("must not run");
    const route = createRouter({ models: { chat: [primary, secondary] } });
    const controller = new AbortController();
    const promise = asV4(route("chat")).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      abortSignal: controller.signal,
    } as LanguageModelV4CallOptions);
    controller.abort(new DOMException("aborted", "AbortError"));

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(secondary.doGenerateCalls).toHaveLength(0);
  });

  it("allows a custom classifier to retry a provider-origin abort", async () => {
    const providerAbort = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(new DOMException("provider stopped", "AbortError")),
    });
    const fallback = okModel("recovered from provider abort");
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({ retryable: true, scope: "transient" }),
      },
      models: { chat: [providerAbort, fallback] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "recovered from provider abort" });
    expect(fallback.doGenerateCalls).toHaveLength(1);
  });

  it("does not let a custom classifier override an actual caller abort", async () => {
    const controller = new AbortController();
    const primary = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) =>
        new Promise((_, reject) =>
          abortSignal?.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true }
          )
        ),
    });
    const fallback = okModel("must not run");
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({ retryable: true, scope: "transient" }),
      },
      models: { chat: [primary, fallback] },
    });
    const reason = new DOMException("caller stopped", "AbortError");
    const request = asV4(route("chat")).doGenerate({
      ...genOptions,
      abortSignal: controller.signal,
    });
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it("uses a stable AbortError when an aborted signal reason is unreadable", async () => {
    const model = okModel("must not run");
    const route = createRouter({ models: { chat: [model] } });
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(controller.signal, "reason", {
      get() {
        throw new Error("reason getter unavailable");
      },
    });

    await expect(
      asV4(route("chat")).doGenerate({
        ...genOptions,
        abortSignal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("does not let an unreadable aborted flag replace a provider failure", async () => {
    const controller = new AbortController();
    let reads = 0;
    Object.defineProperty(controller.signal, "aborted", {
      get() {
        reads += 1;
        if (reads === 6) {
          throw new Error("aborted flag temporarily unavailable");
        }
        return false;
      },
    });
    const fallback = okModel("fallback survived signal accessor");
    const route = createRouter({
      models: { chat: [failingModel("primary failed"), fallback] },
    });

    await expect(
      asV4(route("chat")).doGenerate({
        ...genOptions,
        abortSignal: controller.signal,
      })
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({ text: "fallback survived signal accessor" }),
      ],
    });
    expect(fallback.doGenerateCalls).toHaveLength(1);
    expect(reads).toBeGreaterThanOrEqual(6);
  });

  it("continues routing when the wall clock throws", async () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("wall clock unavailable");
    });
    try {
      const fallback = okModel("recovered without wall clock");
      const route = createRouter({
        models: { chat: [failingModel("primary failed"), fallback] },
      });

      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).resolves.toMatchObject({
        content: [
          expect.objectContaining({ text: "recovered without wall clock" }),
        ],
      });
      expect(fallback.doGenerateCalls).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("preserves caller abort identity after an earlier provider failure", async () => {
    const secondary = new MockLanguageModelV4({
      doGenerate: () => new Promise<never>(() => undefined),
    });
    const tertiary = okModel("must not run");
    const route = createRouter({
      fallback: { retryBudget: true },
      models: { chat: [failingModel("primary failed"), secondary, tertiary] },
    });
    const controller = new AbortController();
    const pending = asV4(route("chat")).doGenerate({
      ...genOptions,
      abortSignal: controller.signal,
    });
    while (secondary.doGenerateCalls.length === 0) {
      await Promise.resolve();
    }
    const reason = new Error("caller stopped fallback");

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(tertiary.doGenerateCalls).toHaveLength(0);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
  });

  it("preserves a total timeout after an earlier provider failure", async () => {
    const hanging = new MockLanguageModelV4({
      doGenerate: () => new Promise<never>(() => undefined),
    });
    const route = createRouter({
      fallback: { totalTimeout: 5 },
      models: { chat: [failingModel("primary failed"), hanging] },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).rejects.toMatchObject({
      code: "total_timeout",
      durationMs: 5,
      name: "RouterTimeoutError",
    });
  });

  it("does not let custom classifiers retry or poison health for router control errors", async () => {
    const hanging = new MockLanguageModelV4({
      doGenerate: () => new Promise<never>(() => undefined),
    });
    const timeoutFallback = okModel("must not run");
    const timeoutRoute = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "credential",
          statusCode: 429,
        }),
        health: true,
        totalTimeout: 5,
      },
      models: { chat: [hanging, timeoutFallback] },
    });

    await expect(
      asV4(timeoutRoute("chat")).doGenerate(genOptions)
    ).rejects.toMatchObject({ code: "total_timeout" });
    expect(timeoutFallback.doGenerateCalls).toHaveLength(0);
    expect(timeoutRoute.getHealthSnapshot("chat")).toEqual([]);

    const validatorFallback = okModel("must not run");
    const validatorRoute = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "credential",
        }),
        validateResult: (() => Promise.resolve(true)) as never,
      },
      models: { chat: [okModel("invalid contract"), validatorFallback] },
    });
    await expect(
      asV4(validatorRoute("chat")).doGenerate(genOptions)
    ).rejects.toMatchObject({ code: "validator_contract_error" });
    expect(validatorFallback.doGenerateCalls).toHaveLength(0);
  });

  it("censors the request when a classifier throws after an earlier provider failure", async () => {
    let classifications = 0;
    const primary = failingModel("primary failed");
    const secondary = failingModel("secondary failed");
    const tertiary = okModel("must not run");
    const failures: Array<{ index: number; scope?: string }> = [];
    const route = createRouter({
      fallback: {
        classifyFailure: () => {
          classifications += 1;
          if (classifications === 1) {
            return { retryable: true, scope: "transient" };
          }
          throw new Error("classifier implementation failed");
        },
        health: true,
        retryBudget: true,
      },
      models: {
        chat: [
          primary,
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: secondary,
          },
          tertiary,
        ],
      },
      onAttempt: ({ failure, index, outcome }) => {
        if (outcome === "failure") {
          failures.push({ index, scope: failure?.scope });
        }
      },
    });

    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toThrow(
      "secondary failed"
    );

    expect(failures).toEqual([
      { index: 0, scope: "transient" },
      { index: 1, scope: "request" },
    ]);
    expect(tertiary.doGenerateCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toHaveLength(1);
    expect(route.getHealthSnapshot("chat")[0].key).toContain(":unit:0");
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
  });

  it("censors a stream when a classifier throws after an earlier error part", async () => {
    let classifications = 0;
    const primary = errorPartStreamModel(new Error("primary stream failed"));
    const secondary = errorPartStreamModel(
      new Error("secondary stream failed")
    );
    const tertiary = streamingModel(["must not run"]);
    const failures: Array<{ index: number; scope?: string }> = [];
    const route = createRouter({
      fallback: {
        classifyFailure: () => {
          classifications += 1;
          if (classifications === 1) {
            return { retryable: true, scope: "transient" };
          }
          throw new Error("stream classifier implementation failed");
        },
        health: true,
        retryBudget: true,
      },
      models: {
        chat: [
          primary,
          {
            adaptiveConcurrency: {
              initial: 2,
              max: 4,
              min: 1,
            },
            model: secondary,
          },
          tertiary,
        ],
      },
      onAttempt: ({ failure, index, outcome }) => {
        if (outcome === "failure") {
          failures.push({ index, scope: failure?.scope });
        }
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "stream" }))
    ).rejects.toThrow("secondary stream failed");

    expect(failures).toEqual([
      { index: 0, scope: "transient" },
      { index: 1, scope: "request" },
    ]);
    expect(tertiary.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toHaveLength(1);
    expect(route.getHealthSnapshot("chat")[0].key).toContain(":unit:0");
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
  });

  it("stops fallback but preserves provider failure state when shouldRetry throws", async () => {
    let calls = 0;
    const primary = new MockLanguageModelV4({
      doGenerate: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            content: [{ type: "text", text: "initial success" }],
            finishReason,
            usage,
            warnings: [],
          });
        }
        return Promise.reject(new Error("provider failed"));
      },
    });
    const fallback = okModel("must not run");
    const route = createRouter({
      fallback: {
        health: true,
        retryBudget: true,
        shouldRetry: () => {
          throw new Error("retry policy failed");
        },
      },
      models: {
        chat: [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: primary,
          },
          fallback,
        ],
      },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "initial success" }],
    });
    expect(route.getAdmissionSnapshot("chat")[0].successes).toBe(1);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toThrow(
      "provider failed"
    );
    expect(fallback.doGenerateCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(1);
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
  });

  it("stops stream fallback but preserves error-part state when shouldRetry throws", async () => {
    let calls = 0;
    const primary = new MockLanguageModelV4({
      doStream: () => {
        calls += 1;
        return {
          stream: simulateReadableStream({
            chunks:
              calls === 1
                ? [
                    { type: "stream-start" as const, warnings: [] },
                    { type: "text-start" as const, id: "1" },
                    {
                      type: "text-delta" as const,
                      id: "1",
                      delta: "initial stream success",
                    },
                    { type: "text-end" as const, id: "1" },
                    { type: "finish" as const, finishReason, usage },
                  ]
                : [
                    { type: "stream-start" as const, warnings: [] },
                    {
                      type: "error" as const,
                      error: new Error("stream provider failed"),
                    },
                  ],
          }),
        };
      },
    });
    const fallback = streamingModel(["must not run"]);
    const route = createRouter({
      fallback: {
        health: true,
        retryBudget: true,
        shouldRetry: () => {
          throw new Error("stream retry policy failed");
        },
      },
      models: {
        chat: [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: primary,
          },
          fallback,
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "valid" }))
    ).resolves.toBe("initial stream success");
    expect(route.getAdmissionSnapshot("chat")[0].successes).toBe(1);

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "failure" }))
    ).rejects.toThrow("stream provider failed");
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(1);
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
  });

  it("omits health transitions for request-scoped caller aborts", async () => {
    const transitions: Array<string | undefined> = [];
    const primary = new MockLanguageModelV4({
      doGenerate: (options) =>
        new Promise((_, reject) => {
          options.abortSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        }),
    });
    const route = createRouter({
      fallback: { health: true },
      models: { chat: [primary] },
      onAttempt: ({ healthTransition }) => transitions.push(healthTransition),
    });
    const controller = new AbortController();
    const pending = asV4(route("chat")).doGenerate({
      ...genOptions,
      abortSignal: controller.signal,
    });
    controller.abort(new DOMException("aborted", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transitions).toEqual([undefined]);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
  });

  it("treats arbitrary abort reasons as request failures when a provider ignores the signal", async () => {
    for (const reason of [new Error("caller stopped"), "caller stopped"]) {
      const failures: Array<{ scope?: string; willRetry?: boolean }> = [];
      const primary = new MockLanguageModelV4({
        doGenerate: () => new Promise<never>(() => undefined),
      });
      const secondary = okModel("must not run");
      const route = createRouter({
        fallback: { health: true, retryBudget: true },
        models: {
          chat: [
            {
              adaptiveConcurrency: { initial: 2, max: 4, min: 1 },
              healthKey: "primary-test-key",
              model: primary,
            },
            secondary,
          ],
        },
        onAttempt: ({ failure, outcome, willRetry }) => {
          if (outcome === "failure") {
            failures.push({ scope: failure?.scope, willRetry });
          }
        },
      });
      const controller = new AbortController();
      const pending = asV4(route("chat")).doGenerate({
        ...genOptions,
        abortSignal: controller.signal,
      });

      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
      expect(secondary.doGenerateCalls).toHaveLength(0);
      expect(failures).toEqual([{ scope: "request", willRetry: false }]);
      expect(route.getHealthSnapshot("chat")).toEqual([]);
      expect(route.getRetryBudgetSnapshot("chat")).toEqual([
        expect.objectContaining({ failures: 0, samples: 0 }),
      ]);
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
        successes: 0,
      });
    }
  });

  it("re-throws the LAST error when every candidate fails", async () => {
    const a = failingModel("first failure");
    const b = failingModel("second failure");
    const c = failingModel("last failure");

    const route = createRouter({
      models: {
        chat: [
          { provider: () => a, model: "a", supports: ["text"] },
          { provider: () => b, model: "b", supports: ["text"] },
          { provider: () => c, model: "c", supports: ["text"] },
        ],
      },
    });

    // The error surfaced is the one from the final candidate, not the first.
    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).rejects.toThrow("last failure");
    expect(a.doGenerateCalls).toHaveLength(1);
    expect(b.doGenerateCalls).toHaveLength(1);
    expect(c.doGenerateCalls).toHaveLength(1);
  });

  it("invokes onError once per failed candidate with { logicalId, entry, index, error }", async () => {
    const primary = failingModel("boom");
    const secondary = okModel("ok");

    const primaryEntry = {
      provider: () => primary,
      model: "p",
      supports: ["text"] as Modality[],
    };
    const secondaryEntry = {
      provider: () => secondary,
      model: "s",
      supports: ["text"] as Modality[],
    };

    const seen: Array<{
      logicalId: string;
      entry: unknown;
      index: number;
      error: unknown;
    }> = [];

    const route = createRouter({
      models: { chat: [primaryEntry, secondaryEntry] },
      onError: (info) => seen.push(info),
    });

    await generateText({ model: route("chat"), prompt: "hi" });

    // Only the failing primary triggers onError; the successful secondary does not.
    expect(seen).toHaveLength(1);
    expect(seen[0].logicalId).toBe("chat");
    expect(seen[0].index).toBe(0);
    expect(seen[0].entry).toBe(primaryEntry);
    expect((seen[0].error as Error).message).toBe("boom");
  });
});

describe("createRouter — modality filtering", () => {
  it("skips a text-only entry and picks the image-capable one when an image is present", async () => {
    const textOnly = okModel("text-only");
    const imageCapable = okModel("image-capable");

    const route = createRouter({
      models: {
        chat: [
          { provider: () => textOnly, model: "t", supports: ["text"] },
          {
            provider: () => imageCapable,
            model: "i",
            supports: ["text", "image"],
          },
        ],
      },
    });

    const { text } = await generateText({
      model: route("chat"),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "describe" }, imagePart],
        },
      ],
    });

    expect(text).toBe("image-capable");
    expect(textOnly.doGenerateCalls).toHaveLength(0);
    expect(imageCapable.doGenerateCalls).toHaveLength(1);
  });

  it('throws a clear "no candidate ... modalities" error when no entry supports the modality', async () => {
    // Only text/image providers are configured, but the prompt carries a PDF.
    const textModel = okModel("text");
    const imageModel = okModel("image");

    const route = createRouter({
      models: {
        chat: [
          { provider: () => textModel, model: "t", supports: ["text"] },
          {
            provider: () => imageModel,
            model: "i",
            supports: ["text", "image"],
          },
        ],
      },
    });

    await expect(
      generateText({
        model: route("chat"),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "read this" },
              {
                type: "file",
                mediaType: "application/pdf",
                // 1x1 transparent png bytes are fine as opaque pdf payload here;
                // detection only reads mediaType, and no candidate matches so
                // the underlying models are never invoked.
                data: "data:application/pdf;base64,JVBERi0xLjQK",
              },
            ],
          },
        ],
      })
    ).rejects.toThrow(NO_CANDIDATE_RE);

    // No candidate matched, so nothing was ever called.
    expect(textModel.doGenerateCalls).toHaveLength(0);
    expect(imageModel.doGenerateCalls).toHaveLength(0);
  });

  it("routes unknown file media types only to generic-file or universal candidates", async () => {
    const textOnly = okModel("text-only");
    const fileModel = okModel("generic-file");
    const route = createRouter({
      models: {
        chat: [
          { model: textOnly, supports: ["text"] },
          { model: fileModel, supports: ["text", "file"] },
        ],
      },
    });

    const result = await generateText({
      model: route("chat"),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "file",
              mediaType: "application/octet-stream",
              data: "data:application/octet-stream;base64,AA==",
            },
          ],
        },
      ],
    });

    expect(result.text).toBe("generic-file");
    expect(textOnly.doGenerateCalls).toHaveLength(0);
  });
});

describe("createRouter — configuration errors", () => {
  it('throws "unknown model id" for an unregistered logical id', () => {
    const route = createRouter({ models: {} });
    expect(() => route("nope")).toThrow("unknown model id");
  });

  it("throws when a logical id maps to an empty candidate list", () => {
    expect(() => createRouter({ models: { chat: [] } })).toThrow(
      "no provider entries"
    );
  });

  it("rejects malformed router and model containers eagerly", () => {
    expect(() => createRouter(null as never)).toThrow(
      "createRouter options must be an object"
    );
    expect(() => createRouter({ models: null } as never)).toThrow(
      "models must be an object"
    );
    expect(() => createRouter({ models: { chat: {} } } as never)).toThrow(
      "must map to a provider entry array"
    );
    expect(() => createRouter({ models: { chat: [null] } } as never)).toThrow(
      "each provider entry must be an object"
    );
  });

  it("bounds logical route ids, route count, and aggregate candidates", () => {
    const candidate = { model: okModel() };
    expect(() => createRouter({ models: { "": [candidate] } })).toThrow(
      "model ids must be non-empty"
    );
    expect(() =>
      createRouter({ models: { ["x".repeat(257)]: [candidate] } })
    ).toThrow("at most 256 characters");

    const routes = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [
        `route-${index}`,
        [candidate],
      ])
    );
    expect(() => createRouter({ models: routes })).toThrow(
      "at most 10000 logical routes"
    );

    let routeReads = 0;
    const guardedRoutes = new Proxy(routes, {
      get(target, key, receiver) {
        routeReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => createRouter({ models: guardedRoutes })).toThrow(
      "at most 10000 logical routes"
    );
    expect(routeReads).toBe(0);

    const candidates = Array.from({ length: 10_000 }, () => candidate);
    const excessive = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`route-${index}`, candidates])
    );
    expect(() => createRouter({ models: excessive })).toThrow(
      "exceed 100000 total candidates"
    );
  });

  it("reads each configured route value exactly once", () => {
    let reads = 0;
    const models = Object.defineProperty({}, "chat", {
      enumerable: true,
      get() {
        reads += 1;
        return [{ model: okModel() }];
      },
    });

    const route = createRouter({ models } as never);

    expect(reads).toBe(1);
    expect(route("chat")).toBeDefined();
  });

  it("validates shared admission conflicts across logical models eagerly", () => {
    expect(() =>
      createRouter({
        models: {
          first: [{ model: okModel(), healthKey: "shared", maxConcurrency: 1 }],
          second: [
            { model: okModel(), healthKey: "shared", maxConcurrency: 2 },
          ],
        },
      })
    ).toThrow("must use identical concurrency settings");
  });

  it("does not treat inherited object properties as configured model ids", () => {
    const route = createRouter({ models: {} });
    expect(() => route("toString")).toThrow("unknown model id");
  });

  it("validates factory entry shape eagerly without invoking valid factories", () => {
    expect(() =>
      createRouter({
        models: { chat: [{ model: "missing-provider" } as never] },
      })
    ).toThrow("requires a `provider` function");

    let calls = 0;
    createRouter({
      models: {
        chat: [
          {
            model: "valid",
            provider: () => {
              calls += 1;
              return okModel();
            },
          },
        ],
      },
    });
    expect(calls).toBe(0);
  });

  it("snapshots accessor-backed factory fields exactly once", async () => {
    let modelReads = 0;
    let providerReads = 0;
    const model = okModel("accessor snapshot");
    const entry = Object.defineProperties(
      {},
      {
        model: {
          enumerable: true,
          get() {
            modelReads += 1;
            if (modelReads > 1) {
              throw new Error("model read twice");
            }
            return "model-id";
          },
        },
        provider: {
          enumerable: true,
          get() {
            providerReads += 1;
            if (providerReads > 1) {
              throw new Error("provider read twice");
            }
            return function (this: unknown) {
              expect(this).toBe(entry);
              return model;
            };
          },
        },
      }
    );

    const route = createRouter({ models: { chat: [entry as never] } });
    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "accessor snapshot" });
    expect({ modelReads, providerReads }).toEqual({
      modelReads: 1,
      providerReads: 1,
    });
  });

  it("snapshots instance routing and health accessors exactly once", async () => {
    const reads = {
      adaptiveConcurrency: 0,
      healthKey: 0,
      maxConcurrency: 0,
      model: 0,
      providerFamily: 0,
      supports: 0,
    };
    const values = {
      adaptiveConcurrency: { initial: 1, max: 2, min: 1 },
      healthKey: "stable-health",
      maxConcurrency: 1,
      model: okModel("stable instance"),
      providerFamily: "stable-family",
      supports: ["text"],
    };
    const entry = {} as Record<string, unknown>;
    for (const key of Object.keys(reads) as Array<keyof typeof reads>) {
      Object.defineProperty(entry, key, {
        configurable: true,
        get() {
          reads[key] += 1;
          return values[key];
        },
      });
    }
    const route = createRouter({ models: { chat: [entry as never] } });
    for (const key of Object.keys(reads)) {
      Object.defineProperty(entry, key, {
        value: () => {
          throw new Error(`${key} mutated accessor must not run`);
        },
      });
    }

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "stable instance" });
    expect(reads).toEqual({
      adaptiveConcurrency: 1,
      healthKey: 1,
      maxConcurrency: 1,
      model: 1,
      providerFamily: 1,
      supports: 1,
    });
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      limit: 1,
      max: 2,
      min: 1,
    });
  });

  it("snapshots router fallback and hook accessors once across logical models", async () => {
    const reads = { fallback: 0, onAttempt: 0, onError: 0 };
    const once =
      <T>(key: keyof typeof reads, value: T) =>
      () => {
        reads[key] += 1;
        if (reads[key] > 1) {
          throw new Error(`${key} read twice`);
        }
        return value;
      };
    const options = Object.defineProperties(
      {
        models: { first: [okModel("first")], second: [okModel("second")] },
      },
      {
        fallback: {
          enumerable: true,
          get: once("fallback", { retryBudget: { minSamples: 2 } }),
        },
        onAttempt: {
          enumerable: true,
          get: once("onAttempt", () => undefined),
        },
        onError: {
          enumerable: true,
          get: once("onError", () => undefined),
        },
      }
    );

    const route = createRouter(options as never);
    await expect(
      generateText({ model: route("first"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "first" });
    await expect(
      generateText({ model: route("second"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "second" });
    expect(reads).toEqual({ fallback: 1, onAttempt: 1, onError: 1 });
  });

  it("ignores unknown fallback extension getters while snapshotting", async () => {
    const fallback = Object.defineProperty({ maxAttempts: 1 }, "unknown", {
      enumerable: true,
      get() {
        throw new Error("unknown option must not be read");
      },
    });
    const route = createRouter({
      fallback: fallback as never,
      models: { chat: [okModel("ok")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "ok" });
  });

  it("ignores unknown adaptive-concurrency getters while snapshotting", async () => {
    const adaptive = Object.defineProperty(
      { initial: 1, max: 2, min: 1 },
      "unknown",
      {
        enumerable: true,
        get() {
          throw new Error("unknown adaptive option must not be read");
        },
      }
    );
    const route = createRouter({
      models: {
        chat: [{ adaptiveConcurrency: adaptive, model: okModel("ok") }],
      },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "ok" });
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      limit: 1,
      max: 2,
      min: 1,
    });
  });

  it("validates custom health-store method contracts eagerly", () => {
    expect(() =>
      createRouter({
        fallback: { healthStore: 42 as never },
        models: { chat: [okModel()] },
      })
    ).toThrow("healthStore must be an object");
    expect(() =>
      createRouter({
        fallback: { healthStore: {} as never },
        models: { chat: [okModel()] },
      })
    ).toThrow("healthStore.delete must be a function");
    expect(() =>
      createRouter({
        fallback: {
          healthStore: {
            compareAndSet: 1,
            delete: vi.fn(),
            get: vi.fn(),
            set: vi.fn(),
          } as never,
        },
        models: { chat: [okModel()] },
      })
    ).toThrow("healthStore.compareAndSet must be a function");
  });

  it("consumes Promise-valued health-store method siblings", async () => {
    expect(() =>
      createRouter({
        fallback: {
          healthStore: {
            compareAndSet: Promise.reject(new Error("async CAS method")),
            delete: Promise.reject(new Error("async delete method")),
            entries: Promise.reject(new Error("async entries method")),
            get: Promise.reject(new Error("async get method")),
            set: Promise.reject(new Error("async set method")),
          } as never,
        },
        models: { chat: [okModel()] },
      })
    ).toThrow("synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("constructs ordering sources when platform entropy is unavailable", async () => {
    const uuid = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(() => {
        throw new Error("crypto unavailable");
      });
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("random unavailable");
    });
    try {
      const route = createRouter({ models: { chat: [okModel("safe")] } });
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).resolves.toMatchObject({ content: [{ text: "safe" }] });
    } finally {
      uuid.mockRestore();
      random.mockRestore();
    }
  });

  it("consumes Promise-valued ordering entropy", async () => {
    const uuid = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(
        () => Promise.reject(new Error("async UUID entropy")) as never
      );
    const random = vi
      .spyOn(Math, "random")
      .mockImplementation(
        () => Promise.reject(new Error("async random entropy")) as never
      );
    try {
      const route = createRouter({ models: { chat: [okModel("safe")] } });
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).resolves.toMatchObject({ content: [{ text: "safe" }] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      random.mockRestore();
      uuid.mockRestore();
    }
  });

  it("consumes Promise-valued ordering clock samples", async () => {
    const source = new OrderingTokenSource();
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(
        () => Promise.reject(new Error("async ordering clock")) as never
      );
    try {
      expect(String(source.next()).startsWith("v1:")).toBe(true);
    } finally {
      now.mockRestore();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not start or fan out providers when timer registration fails", async () => {
    const primary = okModel("must not run");
    const secondary = okModel("must not run either");
    const route = createRouter({
      fallback: { attemptTimeout: 1000 },
      models: { chat: [primary, secondary] },
    });
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => {
      throw new Error("timer unavailable");
    });
    try {
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).rejects.toMatchObject({ code: "timer_unavailable" });
      expect(primary.doGenerateCalls).toHaveLength(0);
      expect(secondary.doGenerateCalls).toHaveLength(0);
    } finally {
      timer.mockRestore();
    }
  });

  it("generates without AbortController when no cancellation controls are configured", async () => {
    const OriginalAbortController = globalThis.AbortController;
    vi.stubGlobal(
      "AbortController",
      class BrokenAbortController {
        constructor() {
          throw new Error("AbortController unavailable");
        }
      }
    );
    try {
      const route = createRouter({ models: { chat: [okModel("safe")] } });
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).resolves.toMatchObject({ content: [{ text: "safe" }] });
    } finally {
      vi.stubGlobal("AbortController", OriginalAbortController);
    }
  });

  it("does not fan out when required cancellation infrastructure is unavailable", async () => {
    const OriginalAbortController = globalThis.AbortController;
    const primary = okModel("must not run");
    const secondary = okModel("must not run either");
    vi.stubGlobal(
      "AbortController",
      class BrokenAbortController {
        constructor() {
          throw new Error("AbortController unavailable");
        }
      }
    );
    try {
      const route = createRouter({
        fallback: { attemptTimeout: 1000 },
        models: { chat: [primary, secondary] },
      });
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).rejects.toMatchObject({ code: "cancellation_unavailable" });
      expect(primary.doGenerateCalls).toHaveLength(0);
      expect(secondary.doGenerateCalls).toHaveLength(0);
    } finally {
      vi.stubGlobal("AbortController", OriginalAbortController);
    }
  });

  it("cancels an opened upstream when wrapper stream construction fails", async () => {
    const OriginalReadableStream = globalThis.ReadableStream;
    let cancelCalls = 0;
    const upstream = {
      cancel() {
        cancelCalls += 1;
        return Promise.resolve();
      },
    };
    const primary = new MockLanguageModelV4({
      doStream: async () => ({ stream: upstream }) as never,
    });
    const secondary = streamingModel(["must not run"]);
    const route = createRouter({ models: { chat: [primary, secondary] } });
    vi.stubGlobal(
      "ReadableStream",
      class BrokenReadableStream {
        constructor() {
          throw new Error("ReadableStream unavailable");
        }
      }
    );
    try {
      await expect(
        asV4(route("chat")).doStream(genOptions)
      ).rejects.toMatchObject({ code: "stream_unavailable" });
      expect(cancelCalls).toBe(1);
      expect(primary.doStreamCalls).toHaveLength(1);
      expect(secondary.doStreamCalls).toHaveLength(0);
      expect(route.getAdmissionSnapshot("chat")[0]?.inFlight).toBe(0);
    } finally {
      vi.stubGlobal("ReadableStream", OriginalReadableStream);
    }
  });

  it("stops fallback when backoff timer registration fails", async () => {
    const primary = failingModel("primary failed");
    const secondary = okModel("must not run");
    const route = createRouter({
      fallback: { backoff: 1000, health: true, retryBudget: true },
      models: {
        chat: [
          {
            adaptiveConcurrency: { initial: 2, max: 4, min: 1 },
            model: primary,
          },
          secondary,
        ],
      },
    });
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => {
      throw new Error("timer unavailable");
    });
    try {
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).rejects.toMatchObject({ code: "timer_unavailable" });
      expect(primary.doGenerateCalls).toHaveLength(1);
      expect(secondary.doGenerateCalls).toHaveLength(0);
      expect(route.getHealthSnapshot("chat")).toHaveLength(1);
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
        successes: 0,
      });
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 0,
      });
    } finally {
      timer.mockRestore();
    }
  });

  it("censors stream fallback when backoff timer registration fails", async () => {
    const primary = errorPartStreamModel(new Error("primary stream failed"));
    const secondary = streamingModel(["must not run"]);
    const attempts: Array<{
      attempt?: number;
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const route = createRouter({
      fallback: { backoff: 1000, health: true, retryBudget: true },
      models: {
        chat: [
          {
            adaptiveConcurrency: { initial: 2, max: 4, min: 1 },
            model: primary,
          },
          secondary,
        ],
      },
      onAttempt: ({ attempt, index, outcome, reason }) =>
        attempts.push({ attempt, index, outcome, reason }),
    });
    const result = await asV4(route("chat")).doStream(genOptions);
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => {
      throw new Error("timer unavailable");
    });
    try {
      const reader = result.stream.getReader();
      const pending = (async () => {
        while (!(await reader.read()).done) {
          // Drain until fallback backoff attempts to register its timer.
        }
      })();

      await expect(pending).rejects.toMatchObject({
        code: "timer_unavailable",
      });
      expect(primary.doStreamCalls).toHaveLength(1);
      expect(secondary.doStreamCalls).toHaveLength(0);
      expect(route.getHealthSnapshot("chat")).toHaveLength(1);
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
        successes: 0,
      });
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 0,
      });
      expect(attempts).toEqual([
        {
          attempt: 1,
          index: 0,
          outcome: "failure",
          reason: undefined,
        },
      ]);
    } finally {
      timer.mockRestore();
    }
  });

  it("captures custom health-store methods once and preserves receivers", async () => {
    const reads = { compareAndSet: 0, delete: 0, entries: 0, get: 0, set: 0 };
    const records = new Map<string, RouterHealthRecord>();
    const store = {
      records,
      get compareAndSet() {
        reads.compareAndSet += 1;
        return function compareAndSet(
          this: typeof store,
          key: string,
          expectedVersion: number | undefined,
          value: RouterHealthRecord
        ) {
          if (this.records.get(key)?.version !== expectedVersion) {
            return false;
          }
          this.records.set(key, value);
          return true;
        };
      },
      get delete() {
        reads.delete += 1;
        return function deleteRecord(this: typeof store, key: string) {
          this.records.delete(key);
        };
      },
      get entries() {
        reads.entries += 1;
        return function entries(this: typeof store) {
          return this.records.entries();
        };
      },
      get get() {
        reads.get += 1;
        return function getRecord(this: typeof store, key: string) {
          return this.records.get(key);
        };
      },
      get set() {
        reads.set += 1;
        return function setRecord(
          this: typeof store,
          key: string,
          value: RouterHealthRecord
        ) {
          this.records.set(key, value);
        };
      },
    };
    const route = createRouter({
      fallback: { health: true, healthStore: store },
      models: { chat: [failingModel("down"), okModel("recovered")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "recovered" });
    route.getHealthSnapshot("chat");
    expect(reads).toEqual({
      compareAndSet: 1,
      delete: 1,
      entries: 1,
      get: 1,
      set: 1,
    });
  });

  it("rejects malformed candidate capability and identity configuration eagerly", () => {
    expect(() =>
      createRouter({
        models: {
          chat: [{ model: okModel(), supports: "text" } as never],
        },
      })
    ).toThrow("unknown modality");
    expect(() =>
      createRouter({
        models: {
          chat: [{ model: okModel(), supports: new Array(1) } as never],
        },
      })
    ).toThrow("unknown modality");
    expect(() =>
      createRouter({
        models: {
          chat: [{ model: okModel(), supports: new Array(7) } as never],
        },
      })
    ).toThrow("unknown modality");
    expect(() =>
      createRouter({
        models: {
          chat: [{ healthKey: 42, model: okModel() } as never],
        },
      })
    ).toThrow("healthKey must be a string");
    expect(() =>
      createRouter({
        models: {
          chat: [{ adaptiveConcurrency: "yes", model: okModel() } as never],
        },
      })
    ).toThrow("adaptiveConcurrency must be");
    expect(() =>
      createRouter({
        models: {
          chat: [{ adaptiveConcurrency: null, model: okModel() } as never],
        },
      })
    ).toThrow("adaptiveConcurrency must be");
    expect(() =>
      createRouter({
        models: {
          chat: [{ adaptiveConcurrency: [], model: okModel() } as never],
        },
      })
    ).toThrow("adaptiveConcurrency must be");
    expect(() =>
      createRouter({
        models: {
          chat: [
            { adaptiveConcurrency: new Date(), model: okModel() } as never,
          ],
        },
      })
    ).toThrow("adaptiveConcurrency must be");
    expect(() =>
      createRouter({
        models: {
          chat: [{ adaptiveConcurrency: { max: 1e300 }, model: okModel() }],
        },
      })
    ).toThrow("adaptiveConcurrency requires positive integers");
    expect(() =>
      createRouter({
        models: { chat: [{ maxConcurrency: 1e300, model: okModel() }] },
      })
    ).toThrow("maxConcurrency must be a positive integer");
    expect(() =>
      createRouter({
        models: {
          chat: [{ model: okModel(), supports: null } as never],
        },
      })
    ).toThrow("unknown modality");
    expect(() =>
      createRouter({
        models: {
          chat: [{ healthKey: "x".repeat(257), model: okModel() }],
        },
      })
    ).toThrow("healthKey must be at most 256 characters");
    expect(() =>
      createRouter({
        fallback: { healthNamespace: 42 as never },
        models: { chat: [okModel()] },
      })
    ).toThrow("healthNamespace must be a string");
    expect(() =>
      createRouter({
        fallback: { healthNamespace: "x".repeat(257) },
        models: { chat: [okModel()] },
      })
    ).toThrow("healthNamespace must be at most 256 characters");
  });

  it("snapshots supports without calling extension methods or iterators", async () => {
    const supports = ["text"] as Modality[];
    Object.defineProperties(supports, {
      every: {
        value: () => {
          throw new Error("must not call every");
        },
      },
      [Symbol.iterator]: {
        value: () => {
          throw new Error("must not iterate");
        },
      },
    });
    const route = createRouter({
      models: { chat: [{ model: okModel("safe"), supports }] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "safe" });
  });

  it("consumes Promise-valued bounded routing configuration", async () => {
    expect(() =>
      createRouter({
        models: {
          chat: [
            {
              model: okModel(),
              supports: [
                Promise.reject(new Error("async supports entry")),
              ] as never,
            },
          ],
        },
      })
    ).toThrow("unknown modality");
    expect(() =>
      createRouter({
        models: {
          chat: [
            {
              adaptiveConcurrency: {
                increaseAfterSuccesses: Promise.reject(
                  new Error("async increase threshold")
                ),
                initial: Promise.reject(new Error("async initial limit")),
                max: Promise.reject(new Error("async max limit")),
                min: Promise.reject(new Error("async min limit")),
              } as never,
              model: okModel(),
            },
          ],
        },
      })
    ).toThrow("synchronous");
    expect(() =>
      createRouter({
        fallback: {
          retryBudget: {
            maxSamples: Promise.reject(new Error("async max samples")),
            minSamples: Promise.reject(new Error("async min samples")),
            recoveryFailureRate: Promise.reject(
              new Error("async recovery rate")
            ),
            tripFailureRate: Promise.reject(new Error("async trip rate")),
            window: Promise.reject(new Error("async budget window")),
          } as never,
        },
        models: { chat: [okModel()] },
      })
    ).toThrow("synchronous");
    expect(() =>
      createRouter({
        models: {
          chat: [
            {
              adaptiveConcurrency: Promise.reject(
                new Error("async entry adaptive config")
              ),
              healthKey: Promise.reject(new Error("async entry health key")),
              maxConcurrency: Promise.reject(
                new Error("async entry concurrency")
              ),
              model: Promise.reject(new Error("async entry model")),
              provider: Promise.reject(new Error("async entry provider")),
              providerFamily: Promise.reject(
                new Error("async entry provider family")
              ),
              supports: Promise.reject(new Error("async entry supports")),
            } as never,
          ],
        },
      })
    ).toThrow("synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots candidate arrays without calling extension methods or iterators", async () => {
    const entries = [{ model: okModel("safe") }];
    Object.defineProperties(entries, {
      map: {
        value: () => {
          throw new Error("must not call map");
        },
      },
      [Symbol.iterator]: {
        value: () => {
          throw new Error("must not iterate");
        },
      },
    });
    const route = createRouter({ models: { chat: entries } });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "safe" });
  });

  it("rejects malformed retry budget containers eagerly", () => {
    for (const retryBudget of [null, [], new Date(), () => undefined]) {
      expect(() =>
        createRouter({
          fallback: { retryBudget: retryBudget as never },
          models: { chat: [okModel()] },
        })
      ).toThrow("retryBudget must be a boolean or config object");
    }
  });

  it("rejects malformed cooldown containers eagerly", () => {
    for (const cooldown of [null, [], new Date(), () => undefined]) {
      expect(() =>
        createRouter({
          fallback: { cooldown: cooldown as never },
          models: { chat: [okModel()] },
        })
      ).toThrow("cooldown must be a boolean, duration, or config object");
    }
  });

  it("rejects malformed fallback containers eagerly", () => {
    for (const fallback of [null, [], () => undefined, true]) {
      expect(() =>
        createRouter({
          fallback: fallback as never,
          models: { chat: [okModel()] },
        })
      ).toThrow("fallback must be an options object");
    }
  });

  it("consumes Promise-valued root fallback option siblings", async () => {
    expect(() =>
      createRouter({
        fallback: Promise.reject(
          new Error("async fallback container")
        ) as never,
        models: { chat: [okModel()] },
      })
    ).toThrow("synchronous");
    expect(() =>
      createRouter({
        fallback: {
          attemptTimeout: Promise.reject(new Error("async attempt timeout")),
          backoff: Promise.reject(new Error("async backoff")),
          classifyFailure: Promise.reject(new Error("async classifier")),
          cooldown: Promise.reject(new Error("async cooldown")),
          healthStore: Promise.reject(new Error("async health store")),
          retryBudget: Promise.reject(new Error("async retry budget")),
          shouldRetry: Promise.reject(new Error("async retry hook")),
          validateResult: Promise.reject(new Error("async validator")),
        } as never,
        models: { chat: [okModel()] },
      })
    ).toThrow("synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects malformed fallback hooks and boolean policies eagerly", () => {
    for (const name of ["classifyFailure", "shouldRetry", "validateResult"]) {
      expect(() =>
        createRouter({
          fallback: { [name]: true } as never,
          models: { chat: [okModel()] },
        })
      ).toThrow(`fallback.${name} must be a function`);
    }
    for (const name of [
      "health",
      "retryAfterOutput",
      "strictStreamValidation",
    ]) {
      expect(() =>
        createRouter({
          fallback: { [name]: "yes" } as never,
          models: { chat: [okModel()] },
        })
      ).toThrow(`fallback.${name} must be a boolean`);
    }
  });

  it("rejects malformed observability hooks eagerly", () => {
    expect(() =>
      createRouter({
        models: { chat: [okModel()] },
        onAttempt: true as never,
      })
    ).toThrow("onAttempt must be a function");
    expect(() =>
      createRouter({
        models: { chat: [okModel()] },
        onError: "log" as never,
      })
    ).toThrow("onError must be a function");
  });

  it("consumes Promise-valued root router and route siblings", async () => {
    expect(() =>
      createRouter(Promise.reject(new Error("async router options")) as never)
    ).toThrow("synchronous");
    expect(() =>
      createRouter({
        fallback: Promise.reject(new Error("async root fallback")) as never,
        models: Promise.reject(new Error("async root models")) as never,
        onAttempt: Promise.reject(new Error("async attempt hook")) as never,
        onError: Promise.reject(new Error("async error hook")) as never,
      })
    ).toThrow("synchronous");
    expect(() =>
      createRouter({
        models: {
          first: Promise.reject(new Error("async first route")) as never,
          second: Promise.reject(new Error("async second route")) as never,
        },
      })
    ).toThrow("synchronous");
    expect(() =>
      createRouter({
        models: {
          chat: [
            Promise.reject(new Error("async first candidate")),
            Promise.reject(new Error("async second candidate")),
          ] as never,
        },
      })
    ).toThrow("synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots mutable entry configuration at router creation", async () => {
    const supports: Modality[] = ["text"];
    const adaptive = { initial: 1, max: 2, min: 1 };
    const original = okModel("original");
    const replacement = okModel("replacement");
    const entry = {
      adaptiveConcurrency: adaptive,
      model: "original-id",
      provider: (modelId: string) =>
        modelId === "original-id" ? original : replacement,
      supports,
    };
    const route = createRouter({ models: { chat: [entry] } });

    entry.model = "replacement-id";
    entry.provider = () => replacement;
    supports.length = 0;
    adaptive.initial = 99;

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "original" });
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      limit: 1,
      max: 2,
      min: 1,
    });
    expect(replacement.doGenerateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createRouter — streaming
// ---------------------------------------------------------------------------
describe("createRouter — streaming", () => {
  it("streams via the routed model", async () => {
    const model = streamingModel(["Hello", ", world!"]);
    const route = createRouter({
      models: {
        chat: [{ provider: () => model, model: "m", supports: ["text"] }],
      },
    });

    const acc = await collectStream(
      streamText({ model: route("chat"), prompt: "hi" })
    );
    expect(acc).toBe("Hello, world!");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("falls back to the secondary when the primary doStream throws", async () => {
    const primary = failingStreamModel("stream 503");
    const secondary = streamingModel(["from ", "secondary"]);
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

    const acc = await collectStream(
      streamText({ model: route("chat"), prompt: "hi" })
    );
    expect(acc).toBe("from secondary");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("stream 503");
  });

  it("isolates mutable call options across mid-stream fallback", async () => {
    const primary = new MockLanguageModelV4({
      doStream: (options) => {
        const message = options.prompt[0];
        if (message.role !== "system") {
          (message.content[0] as { text?: string }).text = "mutated";
          message.content.length = 0;
        }
        options.prompt.length = 0;
        if (options.headers !== undefined) {
          options.headers.authorization = "mutated";
        }
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { error: new Error("stream failed"), type: "error" },
            ],
          }),
        });
      },
    });
    const secondary = new MockLanguageModelV4({
      doStream: (options) => {
        expect(options.prompt).toEqual([
          {
            content: [{ text: "original", type: "text" }],
            role: "user",
          },
        ]);
        expect(options.headers).toEqual({ authorization: "original" });
        return streamingModel(["isolated stream"]).doStream(options);
      },
    });
    const options: LanguageModelV4CallOptions = {
      headers: { authorization: "original" },
      prompt: [
        {
          content: [{ text: "original", type: "text" }],
          role: "user",
        },
      ],
    };
    const route = createRouter({ models: { chat: [primary, secondary] } });

    const result = await asV4(route("chat")).doStream(options);
    let text = "";
    for await (const part of result.stream) {
      if (part.type === "text-delta") {
        text += part.delta;
      }
    }

    expect(text).toBe("isolated stream");
    expect(options.prompt[0]).toMatchObject({
      content: [{ text: "original", type: "text" }],
    });
    expect(options.headers).toEqual({ authorization: "original" });
  });

  it("allows a custom classifier to retry a provider-origin stream abort", async () => {
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "error",
              error: new DOMException("provider stream stopped", "AbortError"),
            },
          ],
        }),
      }),
    });
    const secondary = streamingModel(["stream recovered"]);
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({ retryable: true, scope: "transient" }),
      },
      models: { chat: [primary, secondary] },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("stream recovered");
    expect(secondary.doStreamCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createRouter — lazy instantiation & caching
// ---------------------------------------------------------------------------
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

  it("caches a permanent invalid-model factory result across fallbacks", async () => {
    let invalidFactoryCalls = 0;
    const fallback = okModel("fallback");
    const route = createRouter({
      models: {
        chat: [
          {
            provider: () => {
              invalidFactoryCalls += 1;
              return { specificationVersion: "v3" } as never;
            },
            model: "invalid",
          },
          fallback,
        ],
      },
    });

    await generateText({ model: route("chat"), prompt: "one" });
    await generateText({ model: route("chat"), prompt: "two" });

    expect(invalidFactoryCalls).toBe(1);
    expect(fallback.doGenerateCalls).toHaveLength(2);
  });

  it("reuses a permanent invalid-model error without retrying its factory during health cooldown", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let factoryCalls = 0;
      const fallback = okModel("fallback");
      const route = createRouter({
        fallback: { health: true },
        models: {
          chat: [
            {
              model: "invalid",
              provider: () => {
                factoryCalls += 1;
                return { specificationVersion: "v3" } as never;
              },
            },
            fallback,
          ],
        },
      });

      await expect(
        generateText({ model: route("chat"), prompt: "first" })
      ).resolves.toMatchObject({
        text: "fallback",
      });
      expect(factoryCalls).toBe(1);
      expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(1);

      await expect(
        generateText({ model: route("chat"), prompt: "cooling" })
      ).resolves.toMatchObject({
        text: "fallback",
      });
      expect(factoryCalls).toBe(1);
      expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(1);

      now = route.getHealthSnapshot("chat")[0].record.cooldownUntil + 1;
      await expect(
        generateText({ model: route("chat"), prompt: "recheck" })
      ).resolves.toMatchObject({
        text: "fallback",
      });
      expect(factoryCalls).toBe(1);
      expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(2);
      expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects and caches a v4-shaped model missing doGenerate", async () => {
    let factoryCalls = 0;
    const fallback = okModel("fallback");
    const route = createRouter({
      models: {
        chat: [
          {
            provider: () => {
              factoryCalls += 1;
              return {
                doStream: () => Promise.reject(new Error("unused")),
                modelId: "incomplete",
                provider: "broken",
                specificationVersion: "v4",
                supportedUrls: {},
              } as never;
            },
            model: "incomplete",
          },
          fallback,
        ],
      },
    });

    await generateText({ model: route("chat"), prompt: "one" });
    await generateText({ model: route("chat"), prompt: "two" });

    expect(factoryCalls).toBe(1);
    expect(fallback.doGenerateCalls).toHaveLength(2);
  });

  it("consumes async required model slots and rejects non-string identity", async () => {
    let asyncFactoryCalls = 0;
    const asyncFallback = okModel("async slot fallback");
    const asyncRoute = createRouter({
      models: {
        chat: [
          {
            model: "async-slots",
            provider: () => {
              asyncFactoryCalls += 1;
              return {
                doGenerate: Promise.reject(new Error("async generate slot")),
                doStream: Promise.reject(new Error("async stream slot")),
                modelId: Promise.reject(new Error("async model id")),
                provider: Promise.reject(new Error("async provider id")),
                specificationVersion: "v4",
              } as never;
            },
          },
          asyncFallback,
        ],
      },
    });

    await expect(
      generateText({ model: asyncRoute("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "async slot fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asyncFactoryCalls).toBe(1);

    const identityFallback = okModel("identity fallback");
    const identityRoute = createRouter({
      models: {
        chat: [
          {
            model: "invalid-identity",
            provider: () =>
              ({
                doGenerate: () => Promise.reject(new Error("unused")),
                doStream: () => Promise.reject(new Error("unused")),
                modelId: 42,
                provider: {},
                specificationVersion: "v4",
              }) as never,
          },
          identityFallback,
        ],
      },
    });
    await expect(
      generateText({ model: identityRoute("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "identity fallback" });
  });

  it("does not cache a throwing factory and releases admission", async () => {
    let factoryCalls = 0;
    const fallback = okModel("fallback");
    const route = createRouter({
      models: {
        chat: [
          {
            healthKey: "factory",
            maxConcurrency: 1,
            model: "throwing",
            provider: () => {
              factoryCalls += 1;
              throw new Error("factory temporarily unavailable");
            },
          },
          fallback,
        ],
      },
    });

    await generateText({ model: route("chat"), prompt: "one" });
    await generateText({ model: route("chat"), prompt: "two" });

    expect(factoryCalls).toBe(2);
    expect(fallback.doGenerateCalls).toHaveLength(2);
  });

  it("cools a transient factory failure without poisoning AIMD or retry budget recovery", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let factoryCalls = 0;
      const recovered = okModel("factory recovered");
      const fallback = okModel("fallback");
      const route = createRouter({
        fallback: { health: true, retryBudget: true },
        models: {
          chat: [
            {
              adaptiveConcurrency: {
                increaseAfterSuccesses: 2,
                initial: 2,
                max: 4,
                min: 1,
              },
              maxConcurrency: 2,
              model: "transient-factory",
              provider: () => {
                factoryCalls += 1;
                if (factoryCalls === 1) {
                  throw new Error("factory temporarily unavailable");
                }
                return recovered;
              },
            },
            fallback,
          ],
        },
      });

      await expect(
        generateText({ model: route("chat"), prompt: "first" })
      ).resolves.toMatchObject({
        text: "fallback",
      });
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
      });
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 1,
      });

      await expect(
        generateText({ model: route("chat"), prompt: "cooling" })
      ).resolves.toMatchObject({
        text: "fallback",
      });
      expect(factoryCalls).toBe(1);

      now = route.getHealthSnapshot("chat")[0].record.cooldownUntil + 1;
      await expect(
        generateText({ model: route("chat"), prompt: "recover" })
      ).resolves.toMatchObject({
        text: "factory recovered",
      });
      expect(factoryCalls).toBe(2);
      expect(route.getHealthSnapshot("chat")).toEqual([]);
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
        successes: 1,
      });
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 3,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("recovers a transient stream factory failure without leaking ownership", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let factoryCalls = 0;
      const recovered = streamingModel(["factory stream recovered"]);
      const fallback = streamingModel(["stream fallback"]);
      const route = createRouter({
        fallback: { health: true, retryBudget: true },
        models: {
          chat: [
            {
              adaptiveConcurrency: {
                initial: 2,
                max: 4,
                min: 1,
              },
              maxConcurrency: 2,
              model: "transient-stream-factory",
              provider: () => {
                factoryCalls += 1;
                if (factoryCalls === 1) {
                  throw new Error("stream factory temporarily unavailable");
                }
                return recovered;
              },
            },
            fallback,
          ],
        },
      });

      await expect(
        collectStream(streamText({ model: route("chat"), prompt: "first" }))
      ).resolves.toBe("stream fallback");
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
      });
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 1,
      });

      await expect(
        collectStream(streamText({ model: route("chat"), prompt: "cooling" }))
      ).resolves.toBe("stream fallback");
      expect(factoryCalls).toBe(1);

      now = route.getHealthSnapshot("chat")[0].record.cooldownUntil + 1;
      await expect(
        collectStream(streamText({ model: route("chat"), prompt: "recover" }))
      ).resolves.toBe("factory stream recovered");

      expect(factoryCalls).toBe(2);
      expect(recovered.doStreamCalls).toHaveLength(1);
      expect(route.getHealthSnapshot("chat")).toEqual([]);
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
        successes: 1,
      });
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 3,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("does not cache transient model accessor failures", async () => {
    let specificationReads = 0;
    let factoryCalls = 0;
    const recovered = okModel("recovered primary");
    const raw = Object.defineProperties(
      {
        doGenerate: recovered.doGenerate.bind(recovered),
        doStream: recovered.doStream.bind(recovered),
      },
      {
        specificationVersion: {
          get() {
            specificationReads += 1;
            if (specificationReads === 1) {
              throw new Error("model metadata temporarily unavailable");
            }
            return "v4";
          },
        },
      }
    ) as unknown as LanguageModelV4;
    const fallback = okModel("fallback");
    const route = createRouter({
      models: {
        chat: [
          {
            model: "transient",
            provider: () => {
              factoryCalls += 1;
              return raw;
            },
          },
          fallback,
        ],
      },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "one" })
    ).resolves.toMatchObject({ text: "fallback" });
    await expect(
      generateText({ model: route("chat"), prompt: "two" })
    ).resolves.toMatchObject({ text: "recovered primary" });

    expect(factoryCalls).toBe(2);
    expect(specificationReads).toBe(2);
  });

  it("consumes and caches rejected async factory results", async () => {
    let factoryCalls = 0;
    const fallback = okModel("fallback");
    const route = createRouter({
      models: {
        chat: [
          {
            model: "async-invalid",
            provider: () => {
              factoryCalls += 1;
              return Promise.reject(new Error("async factory failed")) as never;
            },
          },
          fallback,
        ],
      },
    });

    await generateText({ model: route("chat"), prompt: "one" });
    await generateText({ model: route("chat"), prompt: "two" });
    await Promise.resolve();

    expect(factoryCalls).toBe(1);
    expect(fallback.doGenerateCalls).toHaveLength(2);
  });

  it("ignores arbitrary thenable-like extensions on invalid factory results", async () => {
    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        if (thenReads > 1) {
          throw new Error("then read twice");
        }
        return (_resolve: unknown, reject: (error: Error) => void) => {
          reject(new Error("unsupported async factory"));
          return Promise.reject(new Error("chained thenable failed"));
        };
      },
    });
    const fallback = okModel("fallback");
    const route = createRouter({
      models: {
        chat: [
          { model: "thenable", provider: () => thenable as never },
          fallback,
        ],
      },
    });

    await generateText({ model: route("chat"), prompt: "one" });
    await generateText({ model: route("chat"), prompt: "two" });

    expect(thenReads).toBe(0);
    expect(fallback.doGenerateCalls).toHaveLength(2);
  });

  it("does not read alternate-shape extension getters", async () => {
    const wrapperModel = okModel("wrapped");
    const wrapper = Object.defineProperties(
      {
        model: "wrapped-id",
        provider: () => wrapperModel,
      },
      {
        specificationVersion: {
          get() {
            throw new Error("wrapper specification extension must not be read");
          },
        },
        [["th", "en"].join("")]: {
          get() {
            throw new Error("wrapper then extension must not be read");
          },
        },
      }
    );
    const bare = okModel("bare");
    Object.defineProperty(bare, ["th", "en"].join(""), {
      get() {
        throw new Error("bare then extension must not be read");
      },
    });
    const route = createRouter({
      models: { bare: [bare], wrapped: [wrapper as never] },
    });

    await expect(
      generateText({ model: route("wrapped"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "wrapped" });
    await expect(
      generateText({ model: route("bare"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "bare" });
  });
});

// ---------------------------------------------------------------------------
// createRouter — supportedUrls (conservative intersection across candidates)
// ---------------------------------------------------------------------------
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

  it("accepts cross-realm RegExp patterns and reads array indexes once", () => {
    const crossRealm = runInNewContext(
      "new RegExp('^https://example\\\\.com/', 'gi')"
    ) as RegExp;
    let reads = 0;
    const patterns = new Proxy([crossRealm], {
      get(target, property, receiver) {
        if (property === "0") {
          reads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const model = okModel();
    Object.defineProperty(model, "supportedUrls", {
      value: { "image/*": patterns },
    });
    const route = createRouter({ models: { chat: [model] } });

    const supported = asV4(route("chat")).supportedUrls as Record<
      string,
      RegExp[]
    >;

    expect(reads).toBe(1);
    expect(supported["image/*"][0]).not.toBe(crossRealm);
    expect(supported["image/*"][0]).toMatchObject({
      flags: "gi",
      lastIndex: 0,
      source: crossRealm.source,
    });
  });

  it("copies special supportedUrls keys without prototype mutation", () => {
    const urls = Object.create(null);
    Object.defineProperty(urls, "__proto__", {
      enumerable: true,
      value: [EXAMPLE_HTTPS_RE],
    });
    const model = okModel();
    Object.defineProperty(model, "supportedUrls", { value: urls });
    const route = createRouter({ models: { chat: [model] } });

    const supported = asV4(route("chat")).supportedUrls as Record<
      string,
      RegExp[]
    >;

    expect(Object.getPrototypeOf(supported)).toBe(Object.prototype);
    expect(Object.hasOwn(supported, "__proto__")).toBe(true);
    expect(Reflect.get(supported, "__proto__")).toHaveLength(1);
  });

  it("fails closed on excessive supportedUrls pattern totals and source size", () => {
    const excessiveCount = okModel();
    Object.defineProperty(excessiveCount, "supportedUrls", {
      value: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          `type/${index}`,
          Array.from({ length: 128 }, () => EXAMPLE_HTTPS_RE),
        ])
      ),
    });
    const excessiveSource = okModel();
    Object.defineProperty(excessiveSource, "supportedUrls", {
      value: { "image/*": [new RegExp("a".repeat(4097))] },
    });

    expect(
      asV4(createRouter({ models: { chat: [excessiveCount] } })("chat"))
        .supportedUrls
    ).toEqual({});
    expect(
      asV4(createRouter({ models: { chat: [excessiveSource] } })("chat"))
        .supportedUrls
    ).toEqual({});
  });

  it("fails closed without reading supportedUrls thenable extensions", () => {
    let reads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("then extension must not run");
      },
    });
    const model = okModel();
    Object.defineProperty(model, "supportedUrls", { value: thenable });
    const route = createRouter({ models: { chat: [model] } });

    expect(asV4(route("chat")).supportedUrls).toEqual({});
    expect(reads).toBe(0);
  });

  it("settles async supportedUrls when timer cleanup throws", async () => {
    const clear = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => {
        throw new Error("timer cleanup unavailable");
      });
    try {
      const model = okModel();
      Object.defineProperty(model, "supportedUrls", {
        value: Promise.resolve({ "image/*": [EXAMPLE_HTTPS_RE] }),
      });
      const routed = asV4(createRouter({ models: { chat: [model] } })("chat"));

      await expect(routed.supportedUrls).resolves.toEqual({
        "image/*": [EXAMPLE_HTTPS_RE],
      });
    } finally {
      clear.mockRestore();
    }
  });

  it("fails open when supportedUrls timer registration is unavailable", async () => {
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(
        () => Promise.reject(new Error("async capability timer")) as never
      );
    try {
      const model = okModel();
      Object.defineProperty(model, "supportedUrls", {
        value: Promise.resolve({ "image/*": [EXAMPLE_HTTPS_RE] }),
      });
      const routed = asV4(createRouter({ models: { chat: [model] } })("chat"));

      await expect(routed.supportedUrls).resolves.toEqual({});
      await Promise.resolve();
    } finally {
      timer.mockRestore();
    }
  });

  it("fails closed when async supportedUrls discovery never settles", async () => {
    vi.useFakeTimers();
    try {
      let resolveLookup: ((value: unknown) => void) | undefined;
      const model = okModel("still usable");
      const pending = new Promise<unknown>((resolve) => {
        resolveLookup = resolve;
      });
      Object.defineProperty(model, "supportedUrls", {
        value: pending,
      });
      const route = createRouter({ models: { chat: [model] } });
      const discovery = asV4(route("chat")).supportedUrls;

      await vi.advanceTimersByTimeAsync(1000);
      await expect(discovery).resolves.toEqual({});

      resolveLookup?.({ "image/*": [EXAMPLE_HTTPS_RE] });
      await expect(discovery).resolves.toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// Robust-fallback upgrade: error classification, mid-stream fallback,
// AggregateError surfacing, cooldown, supports-optional, instance entries.
// ===========================================================================

const genOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
} as unknown as LanguageModelV4CallOptions;

/** A model whose doGenerate throws an error carrying an HTTP-ish statusCode. */
function failingModelStatus(statusCode: number, message = "api error") {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.reject(Object.assign(new Error(message), { statusCode })),
  });
}

/** A streaming model that emits stream-start then an in-band error part (no content). */
function errorPartStreamModel(error: unknown) {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "error", error },
        ],
      }),
    }),
  });
}

/** A streaming model whose reader rejects after committing partial text. */
function readErrorStreamModel(error: unknown, text: string | null = "partial") {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doStream: () => {
      let step = 0;
      return Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          pull(controller) {
            if (step === 0) {
              controller.enqueue({ type: "stream-start", warnings: [] });
            } else if (step === 1 && text !== null) {
              controller.enqueue({ id: "primary", type: "text-start" });
            } else if (step === 2 && text !== null) {
              controller.enqueue({
                delta: text,
                id: "primary",
                type: "text-delta",
              });
            } else {
              controller.error(error);
            }
            step += 1;
          },
        }),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// P0-B — error classification (non-retryable errors stop the fallback chain)
// ---------------------------------------------------------------------------
describe("createRouter — error classification (P0-B)", () => {
  it("does not poison candidate health for an unrelated terminal 404", async () => {
    const primary = failingModelStatus(404, "job not found");
    const route = createRouter({
      fallback: { health: true },
      models: { chat: [primary, okModel("must not run")] },
    });
    const model = asV4(route("chat"));

    await expect(model.doGenerate(genOptions)).rejects.toThrow("job not found");
    await expect(model.doGenerate(genOptions)).rejects.toThrow("job not found");

    expect(primary.doGenerateCalls).toHaveLength(2);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
  });

  it("retries a provider-scoped 400 on the next candidate", async () => {
    const primary = failingModelStatus(400, "bad request");
    const secondary = okModel("secondary");
    const seen: Array<{ willRetry?: boolean }> = [];

    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
      onError: (info) => seen.push({ willRetry: info.willRetry }),
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "secondary" });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
    expect(seen).toEqual([{ willRetry: true }]);
  });

  it("honors a custom shouldRetryThisError that refuses to retry", async () => {
    const primary = failingModel("overloaded"); // retryable by default
    const secondary = okModel("secondary");

    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
      fallback: { shouldRetry: () => false },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).rejects.toThrow("overloaded");
    expect(secondary.doGenerateCalls).toHaveLength(0);
  });

  it("lets a custom shouldRetry replace a default non-retryable decision", async () => {
    const primary = failingModelStatus(410, "provider-specific gone");
    const secondary = okModel("secondary");
    const route = createRouter({
      models: { chat: [primary, secondary] },
      fallback: { shouldRetry: () => true },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "secondary" });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });

  it("requires strict boolean retry hooks and valid structured classifications", async () => {
    const malformedRetryFallback = okModel("must not run");
    const malformedRetry = createRouter({
      fallback: { shouldRetry: (() => "yes") as never },
      models: { chat: [failingModel("down"), malformedRetryFallback] },
    });
    await expect(
      asV4(malformedRetry("chat")).doGenerate(genOptions)
    ).rejects.toThrow("down");
    expect(malformedRetryFallback.doGenerateCalls).toHaveLength(0);

    const malformedClassifyFallback = okModel("must not run");
    const malformedClassify = createRouter({
      fallback: { classifyFailure: (() => undefined) as never },
      models: { chat: [failingModel("down"), malformedClassifyFallback] },
    });
    await expect(
      asV4(malformedClassify("chat")).doGenerate(genOptions)
    ).rejects.toThrow("down");
    expect(malformedClassifyFallback.doGenerateCalls).toHaveLength(0);

    const fractionalStatusFallback = okModel("must not run");
    const fractionalStatus = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "credential",
          statusCode: 429.5,
        }),
      },
      models: { chat: [failingModel("down"), fractionalStatusFallback] },
    });
    await expect(
      asV4(fractionalStatus("chat")).doGenerate(genOptions)
    ).rejects.toThrow("down");
    expect(fractionalStatusFallback.doGenerateCalls).toHaveLength(0);

    for (const statusCode of [99, 600]) {
      const outOfRangeFallback = okModel("must not run");
      const outOfRange = createRouter({
        fallback: {
          classifyFailure: () => ({
            retryable: true,
            scope: "credential",
            statusCode,
          }),
        },
        models: { chat: [failingModel("down"), outOfRangeFallback] },
      });
      await expect(
        asV4(outOfRange("chat")).doGenerate(genOptions)
      ).rejects.toThrow("down");
      expect(outOfRangeFallback.doGenerateCalls).toHaveLength(0);
    }

    let coercions = 0;
    const coercibleScopeFallback = okModel("must not run");
    const coercibleScope = createRouter({
      fallback: {
        classifyFailure: (() => ({
          retryable: true,
          scope: {
            toString() {
              coercions += 1;
              return "transient";
            },
          },
        })) as never,
      },
      models: { chat: [failingModel("down"), coercibleScopeFallback] },
    });
    await expect(
      asV4(coercibleScope("chat")).doGenerate(genOptions)
    ).rejects.toThrow("down");
    expect(coercions).toBe(0);
    expect(coercibleScopeFallback.doGenerateCalls).toHaveLength(0);

    const asyncFallback = okModel("must not run");
    const asyncClassification = createRouter({
      fallback: {
        classifyFailure: (() =>
          Promise.reject(new Error("async classifier rejected"))) as never,
      },
      models: { chat: [failingModel("down"), asyncFallback] },
    });
    await expect(
      asV4(asyncClassification("chat")).doGenerate(genOptions)
    ).rejects.toThrow("down");
    await Promise.resolve();
    expect(asyncFallback.doGenerateCalls).toHaveLength(0);
  });

  it("reads structured classification fields once", async () => {
    const reads = new Map<string, number>();
    const values = {
      cooldownMs: 25,
      retryable: true,
      retryAfterMs: 50,
      scope: "transient",
      statusCode: 503,
    } as const;
    const classification = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          {
            get() {
              reads.set(key, (reads.get(key) ?? 0) + 1);
              return value;
            },
          },
        ])
      )
    );
    const fallback = okModel("recovered");
    const route = createRouter({
      fallback: { classifyFailure: (() => classification) as never },
      models: { chat: [failingModel("down"), fallback] },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ text: "recovered", type: "text" }],
    });
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(reads.size).toBe(Object.keys(values).length);
  });
});

// ---------------------------------------------------------------------------
// P0-C — error surfacing (AggregateError on multi-failure; original on single)
// ---------------------------------------------------------------------------
describe("createRouter — error surfacing (P0-C)", () => {
  it("keeps aggregate summaries stable when observability mutates errors", async () => {
    const first = new Error("first original");
    const last = new Error("last original");
    const route = createRouter({
      models: {
        chat: [
          new MockLanguageModelV4({
            doGenerate: () => Promise.reject(first),
          }),
          new MockLanguageModelV4({
            doGenerate: () => Promise.reject(last),
          }),
        ],
      },
      onError: ({ error }) => {
        if (error instanceof Error) {
          error.message = "mutated by hook";
        }
      },
    });

    let surfaced: unknown;
    try {
      await asV4(route("chat")).doGenerate(genOptions);
    } catch (error) {
      surfaced = error;
    }

    expect(surfaced).toBeInstanceOf(AggregateError);
    expect((surfaced as AggregateError).message).toContain("last original");
    expect((surfaced as AggregateError).message).not.toContain(
      "mutated by hook"
    );
    expect((surfaced as AggregateError).cause).toBe(last);
  });

  it("throws an AggregateError of all candidate errors when several fail", async () => {
    const a = failingModelStatus(503, "first 503");
    const b = failingModelStatus(503, "second 503");
    const c = failingModelStatus(503, "last 503");

    const route = createRouter({
      models: {
        chat: [
          { provider: () => a, model: "a", supports: ["text"] },
          { provider: () => b, model: "b", supports: ["text"] },
          { provider: () => c, model: "c", supports: ["text"] },
        ],
      },
    });

    const err = await asV4(route("chat"))
      .doGenerate(genOptions)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toHaveLength(3);
    expect((err as AggregateError).message).toContain("last 503");
    expect((err as AggregateError).cause).toBe(
      (err as AggregateError).errors.at(-1)
    );
  });

  it("surfaces the ORIGINAL error verbatim for a single failing candidate", async () => {
    const onlyError = Object.assign(new Error("lonely 503"), {
      statusCode: 503,
    });
    const only = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(onlyError),
    });

    const route = createRouter({
      models: {
        chat: [{ provider: () => only, model: "o", supports: ["text"] }],
      },
    });

    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toBe(
      onlyError
    );
  });
});

// ---------------------------------------------------------------------------
// P0-A — mid-stream fallback (error AFTER the stream opens, before content)
// ---------------------------------------------------------------------------
describe("createRouter — mid-stream fallback (P0-A)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares the longest pre-output stream error reset until expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = Object.assign(new Error("credential limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const primary = errorPartStreamModel(failure);
    const route = createRouter({
      fallback: { health: true, healthNamespace: "pre-output-reset" },
      models: {
        first: [
          { healthKey: "shared-key", model: primary },
          {
            healthKey: "first-fallback",
            model: streamingModel(["first"]),
          },
        ],
        second: [
          { healthKey: "shared-key", model: primary },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second"]),
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "initial" }))
    ).resolves.toBe("first");
    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "cooling" }))
    ).resolves.toBe("second");
    expect(primary.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(streamText({ model: route("first"), prompt: "probe" }))
    ).resolves.toBe("first");
    expect(primary.doStreamCalls).toHaveLength(2);
  });

  it("propagates post-output credential failure into shared health", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = Object.assign(new Error("credential limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          chunks: [
            { type: "stream-start", warnings: [] },
            { id: "primary", type: "text-start" },
            { delta: "partial ", id: "primary", type: "text-delta" },
            { type: "error", error: failure },
          ],
        }),
      }),
    });
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "post-output",
        retryAfterOutput: true,
      },
      models: {
        first: [
          { healthKey: "shared-key", model: primary },
          {
            healthKey: "first-fallback",
            model: streamingModel(["secondary"]),
          },
        ],
        second: [
          { healthKey: "shared-key", model: primary },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second"]),
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "one" }))
    ).resolves.toBe("partial secondary");
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "two" }))
    ).resolves.toBe("second");

    expect(primary.doStreamCalls).toHaveLength(1);
    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "cooling" }))
    ).resolves.toBe("second");
    expect(primary.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(streamText({ model: route("first"), prompt: "probe" }))
    ).resolves.toBe("partial secondary");
    expect(primary.doStreamCalls).toHaveLength(2);
    const credential = route
      .getHealthSnapshot()
      .filter(({ key }) => key.includes(":credential:"));
    expect(credential).toHaveLength(1);
    expect(credential[0].record.lastStatus).toBe(429);
  });

  it("learns shared cooldown when post-output retry is disabled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = Object.assign(
      new Error("credential limited after output"),
      {
        responseHeaders: {
          "x-ratelimit-reset-requests": "90s",
          "x-ratelimit-reset-tokens": "120s",
        },
        statusCode: 429,
      }
    );
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { id: "primary", type: "text-start" },
            { delta: "partial", id: "primary", type: "text-delta" },
            { type: "error", error: failure },
          ],
        }),
      }),
    });
    const seen: unknown[] = [];
    const route = createRouter({
      fallback: { health: true, healthNamespace: "no-post-output-retry" },
      models: {
        first: [
          { healthKey: "shared-key", model: primary },
          {
            healthKey: "first-fallback",
            model: streamingModel(["first fallback"]),
          },
        ],
        second: [
          { healthKey: "shared-key", model: primary },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second fallback"]),
          },
        ],
      },
      onError: ({ error }) => seen.push(error),
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "initial" }))
    ).resolves.toBe("partial");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(seen).toEqual([failure]);

    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "cooling" }))
    ).resolves.toBe("second fallback");
    expect(primary.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(streamText({ model: route("first"), prompt: "probe" }))
    ).resolves.toBe("partial");
    expect(primary.doStreamCalls).toHaveLength(2);
    expect(seen).toEqual([failure, failure]);
  });

  it("discards prelude and recovers from a pre-output read rejection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = Object.assign(new Error("pre-output read limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const primary = readErrorStreamModel(failure, null);
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "pre-output-read-error",
        retryBudget: true,
      },
      models: {
        first: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          {
            healthKey: "first-fallback",
            model: streamingModel(["first fallback"]),
          },
        ],
        second: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second fallback"]),
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "initial" }))
    ).resolves.toBe("first fallback");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(route.getAdmissionSnapshot("first")[0].inFlight).toBe(0);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "cooling" }))
    ).resolves.toBe("second fallback");
    expect(primary.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(streamText({ model: route("first"), prompt: "probe" }))
    ).resolves.toBe("first fallback");
    expect(primary.doStreamCalls).toHaveLength(2);
    expect(route.getAdmissionSnapshot("first")[0].inFlight).toBe(0);
  });

  it("settles a post-output read rejection without retrying the current stream", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = Object.assign(new Error("read credential limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const primary = readErrorStreamModel(failure);
    const attempts: Array<{
      inFlight?: number;
      outcome: string;
      phase?: string;
    }> = [];
    const seen: unknown[] = [];
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "read-error-no-retry",
        retryBudget: true,
      },
      models: {
        first: [
          {
            healthKey: "shared-key",
            maxConcurrency: 1,
            model: primary,
          },
          {
            healthKey: "first-fallback",
            model: streamingModel(["must not run"]),
          },
        ],
        second: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second fallback"]),
          },
        ],
      },
      onAttempt: ({ inFlight, outcome, phase }) => {
        attempts.push({ inFlight, outcome, phase });
      },
      onError: ({ error }) => seen.push(error),
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "initial" }))
    ).rejects.toBe(failure);
    expect(seen).toEqual([failure]);
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(route.getAdmissionSnapshot("first")[0].inFlight).toBe(0);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 1,
      samples: 1,
    });
    expect(attempts).toContainEqual({
      inFlight: 1,
      outcome: "failure",
      phase: "stream-mid",
    });

    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "cooling" }))
    ).resolves.toBe("second fallback");
    expect(primary.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "probe" }))
    ).rejects.toBe(failure);
    expect(primary.doStreamCalls).toHaveLength(2);
    expect(route.getAdmissionSnapshot("second")[0].inFlight).toBe(0);
  });

  it("falls back after a post-output read rejection when enabled", async () => {
    const failure = Object.assign(new Error("read credential limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const primary = readErrorStreamModel(failure);
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "read-error-retry",
        retryAfterOutput: true,
        retryBudget: true,
      },
      models: {
        first: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          {
            healthKey: "first-fallback",
            model: streamingModel([" fallback"]),
          },
        ],
        second: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second"]),
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "initial" }))
    ).resolves.toBe("partial fallback");
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "shared" }))
    ).resolves.toBe("second");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(route.getAdmissionSnapshot("first")[0].inFlight).toBe(0);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
  });

  it("keeps caller abort request-scoped when it triggers a read rejection", async () => {
    const providerFailure = Object.assign(new Error("abort-side 429"), {
      responseHeaders: { "x-ratelimit-reset-tokens": "120s" },
      statusCode: 429,
    });
    let readWaiting: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      readWaiting = resolve;
    });
    const primary = new MockLanguageModelV4({
      doStream: (options) => {
        let step = 0;
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            pull(controller) {
              if (step === 0) {
                controller.enqueue({ type: "stream-start", warnings: [] });
              } else if (step === 1) {
                controller.enqueue({ id: "primary", type: "text-start" });
              } else if (step === 2) {
                controller.enqueue({
                  delta: "partial",
                  id: "primary",
                  type: "text-delta",
                });
              } else {
                readWaiting?.();
                options.abortSignal?.addEventListener(
                  "abort",
                  () => controller.error(providerFailure),
                  { once: true }
                );
              }
              step += 1;
            },
          }),
        });
      },
    });
    const fallback = streamingModel(["must not run"]);
    const attempts: Array<{ outcome: string }> = [];
    const route = createRouter({
      fallback: {
        health: true,
        retryAfterOutput: true,
        retryBudget: true,
      },
      models: {
        chat: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          fallback,
        ],
      },
      onAttempt: ({ outcome }) => attempts.push({ outcome }),
    });
    const caller = new AbortController();
    const reason = new Error("caller stopped pending read");
    const result = collectStream(
      streamText({
        abortSignal: caller.signal,
        model: route("chat"),
        prompt: "abort race",
      })
    );
    await waiting;

    caller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
    expect(attempts).toEqual([]);
  });

  it("keeps caller abort request-scoped when it triggers an error part", async () => {
    const providerFailure = Object.assign(new Error("abort-side error 429"), {
      responseHeaders: { "x-ratelimit-reset-tokens": "120s" },
      statusCode: 429,
    });
    let errorPartWaiting: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      errorPartWaiting = resolve;
    });
    const primary = new MockLanguageModelV4({
      doStream: (options) => {
        let step = 0;
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            pull(controller) {
              if (step === 0) {
                controller.enqueue({ type: "stream-start", warnings: [] });
              } else if (step === 1) {
                controller.enqueue({ id: "primary", type: "text-start" });
              } else if (step === 2) {
                controller.enqueue({
                  delta: "partial",
                  id: "primary",
                  type: "text-delta",
                });
              } else {
                errorPartWaiting?.();
                options.abortSignal?.addEventListener(
                  "abort",
                  () => {
                    controller.enqueue({
                      error: providerFailure,
                      type: "error",
                    });
                    controller.close();
                  },
                  { once: true }
                );
              }
              step += 1;
            },
          }),
        });
      },
    });
    const fallback = streamingModel(["must not run"]);
    const attempts: Array<{ outcome: string }> = [];
    const route = createRouter({
      fallback: { health: true, retryBudget: true },
      models: {
        chat: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          fallback,
        ],
      },
      onAttempt: ({ outcome }) => attempts.push({ outcome }),
    });
    const listeners = new Set<() => void>();
    const capturedReason = new Error("caller stopped pending error part");
    const mutatedReason = new Error("mutated caller reason");
    let aborted = false;
    let reasonReads = 0;
    const callerSignal = {
      addEventListener(_name: string, listener: () => void) {
        listeners.add(listener);
      },
      get aborted() {
        return aborted;
      },
      get reason() {
        reasonReads += 1;
        return reasonReads === 1 ? capturedReason : mutatedReason;
      },
      removeEventListener(_name: string, listener: () => void) {
        listeners.delete(listener);
      },
    } as unknown as AbortSignal;
    const result = await asV4(route("chat")).doStream({
      ...genOptions,
      abortSignal: callerSignal,
    });
    const reader = result.stream.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    const pending = reader.read();
    await waiting;

    aborted = true;
    for (const listener of [...listeners]) {
      listener();
    }

    await expect(pending).rejects.toBe(capturedReason);
    expect(reasonReads).toBe(1);
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
    expect(attempts).toEqual([]);
  });

  it("keeps caller abort authoritative over a later consumer cancel", async () => {
    let readWaiting: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      readWaiting = resolve;
    });
    const upstreamCancelReasons: unknown[] = [];
    const primary = new MockLanguageModelV4({
      doStream: () => {
        let step = 0;
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            cancel(reason) {
              upstreamCancelReasons.push(reason);
            },
            pull(controller) {
              if (step === 0) {
                controller.enqueue({ type: "stream-start", warnings: [] });
              } else if (step === 1) {
                controller.enqueue({ id: "primary", type: "text-start" });
              } else if (step === 2) {
                controller.enqueue({
                  delta: "partial",
                  id: "primary",
                  type: "text-delta",
                });
              } else {
                readWaiting?.();
                return new Promise<void>(() => undefined);
              }
              step += 1;
            },
          }),
        });
      },
    });
    const attempts: Array<{ outcome: string }> = [];
    const route = createRouter({
      fallback: { health: true, retryBudget: true },
      models: {
        chat: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          streamingModel(["must not run"]),
        ],
      },
      onAttempt: ({ outcome }) => attempts.push({ outcome }),
    });
    const caller = new AbortController();
    const callerReason = new Error("caller stopped first");
    const consumerReason = new Error("consumer cancelled second");
    const result = await asV4(route("chat")).doStream({
      ...genOptions,
      abortSignal: caller.signal,
    });
    const reader = result.stream.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    const pending = reader.read();
    await waiting;

    caller.abort(callerReason);
    await reader.cancel(consumerReason);
    await pending;

    expect(upstreamCancelReasons).toEqual([callerReason]);
    expect(attempts).toEqual([]);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
  });

  it("keeps consumer cancel authoritative over a later caller abort", async () => {
    const upstreamCancelReasons: unknown[] = [];
    const primary = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            cancel(reason) {
              upstreamCancelReasons.push(reason);
            },
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ id: "primary", type: "text-start" });
              controller.enqueue({
                delta: "partial",
                id: "primary",
                type: "text-delta",
              });
            },
          }),
        }),
    });
    const attempts: Array<{ outcome: string }> = [];
    const route = createRouter({
      fallback: { health: true, retryBudget: true },
      models: {
        chat: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          streamingModel(["must not run"]),
        ],
      },
      onAttempt: ({ outcome }) => attempts.push({ outcome }),
    });
    const caller = new AbortController();
    const consumerReason = new Error("consumer cancelled first");
    const callerReason = new Error("caller stopped second");
    const result = await asV4(route("chat")).doStream({
      ...genOptions,
      abortSignal: caller.signal,
    });
    const reader = result.stream.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    const pending = reader.read();

    await reader.cancel(consumerReason);
    caller.abort(callerReason);
    await pending;

    expect(upstreamCancelReasons).toEqual([consumerReason]);
    expect(attempts).toEqual([{ outcome: "cancelled" }]);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
  });

  it("does not retry a pre-output stream error with a wrapped abort cause", async () => {
    const abort = new DOMException("caller stopped", "AbortError");
    const wrappedFailure = Object.assign(new Error("gateway stream failed"), {
      cause: abort,
    });
    const primary = errorPartStreamModel(wrappedFailure);
    const secondary = streamingModel(["must not run"]);
    const route = createRouter({
      fallback: { health: true },
      models: { chat: [primary, secondary] },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).rejects.toBe(wrappedFailure);
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
  });

  it("reads a terminal stream error code once across classification layers", async () => {
    let reads = 0;
    const failure = Object.defineProperty(
      new Error("contract failed"),
      "code",
      {
        get() {
          reads += 1;
          return "call_options_contract_error";
        },
      }
    );
    const primary = errorPartStreamModel(failure);
    const secondary = streamingModel(["must not run"]);
    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).rejects.toBe(failure);
    expect(reads).toBe(1);
    expect(secondary.doStreamCalls).toHaveLength(0);
  });

  it("evaluates a custom retry hook once for a pre-output stream failure", async () => {
    const primary = errorPartStreamModel(new Error("overloaded 503"));
    const secondary = streamingModel(["from secondary"]);
    const shouldRetry = vi.fn(() => true);
    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
      fallback: { shouldRetry },
    });

    const acc = await collectStream(
      streamText({ model: route("chat"), prompt: "hi" })
    );

    expect(acc).toBe("from secondary");
    expect(shouldRetry).toHaveBeenCalledOnce();
  });

  it("falls back transparently on a pre-output error part through streamText", async () => {
    const primary = errorPartStreamModel(new Error("overloaded 503"));
    const secondary = streamingModel(["from ", "secondary"]);
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

    const acc = await collectStream(
      streamText({ model: route("chat"), prompt: "hi" })
    );
    expect(acc).toBe("from secondary");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("overloaded 503");
  });
});

// ---------------------------------------------------------------------------
// P2-A — supports optional (omitted supports => universal candidate)
// ---------------------------------------------------------------------------
describe("createRouter — supports optional (P2-A)", () => {
  it("routes a modality to an entry with omitted supports when siblings reject it", async () => {
    const textOnly = okModel("text-only");
    const universal = okModel("universal");

    const route = createRouter({
      models: {
        chat: [
          { provider: () => textOnly, model: "t", supports: ["text"] },
          { provider: () => universal, model: "u" }, // no supports => matches any modality
        ],
      },
    });

    const { text } = await generateText({
      model: route("chat"),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "describe" }, imagePart],
        },
      ],
    });

    expect(text).toBe("universal");
    expect(textOnly.doGenerateCalls).toHaveLength(0);
    expect(universal.doGenerateCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// P2-B — direct model instances (instance object + bare shorthand)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// P1 — cooldown (opt-in sticky+reset)
// ---------------------------------------------------------------------------
describe("createRouter — cooldown (P1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is stateless by default: every request re-probes the failing primary", async () => {
    const primary = failingModel("503 overloaded");
    const secondary = okModel("secondary");
    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
    });
    const routed = route("chat");
    await generateText({ model: routed, prompt: "a" });
    await generateText({ model: routed, prompt: "b" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("sticks to the survivor and re-probes the primary after modelResetInterval", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const primary = failingModel("503 overloaded");
    const secondary = okModel("secondary");
    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
      fallback: { cooldown: true },
    });
    const routed = route("chat");

    // Request 1: primary fails, secondary serves -> survivor becomes the secondary.
    await generateText({ model: routed, prompt: "a" });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);

    // Request 2: starts directly at the sticky survivor; the dead primary is skipped.
    await generateText({ model: routed, prompt: "b" });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(2);

    // After the reset interval elapses, the next request re-probes the primary.
    vi.setSystemTime(new Date("2026-01-01T00:04:00Z")); // +4 min > default 3 min
    await generateText({ model: routed, prompt: "c" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("falls back to earlier candidates when the sticky survivor fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let primaryHealthy = false;
    let stickyHealthy = true;
    const primary = new MockLanguageModelV4({
      doGenerate: () => {
        if (!primaryHealthy) {
          return Promise.reject(new Error("primary unavailable"));
        }
        return Promise.resolve({
          content: [{ type: "text", text: "recovered-primary" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const secondary = failingModel("secondary unavailable");
    const sticky = new MockLanguageModelV4({
      doGenerate: () => {
        if (!stickyHealthy) {
          return Promise.reject(new Error("sticky unavailable"));
        }
        return Promise.resolve({
          content: [{ type: "text", text: "sticky" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const route = createRouter({
      fallback: { cooldown: true },
      models: { chat: [primary, secondary, sticky] },
    });

    expect(
      (await generateText({ model: route("chat"), prompt: "first" })).text
    ).toBe("sticky");
    primaryHealthy = true;
    stickyHealthy = false;
    vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));

    expect(
      (await generateText({ model: route("chat"), prompt: "second" })).text
    ).toBe("recovered-primary");
    expect(primary.doGenerateCalls).toHaveLength(2);
    expect(sticky.doGenerateCalls).toHaveLength(2);
  });

  it("retains earlier stream fallbacks after a sticky stream opener fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let primaryHealthy = false;
    let stickyHealthy = true;
    const primary = new MockLanguageModelV4({
      doStream: () => {
        if (!primaryHealthy) {
          throw new Error("primary unavailable");
        }
        return streamingModel(["recovered-primary"]).doStream({} as never);
      },
    });
    const secondary = failingStreamModel("secondary unavailable");
    const sticky = new MockLanguageModelV4({
      doStream: () => {
        if (!stickyHealthy) {
          throw new Error("sticky unavailable");
        }
        return streamingModel(["sticky"]).doStream({} as never);
      },
    });
    const route = createRouter({
      fallback: { cooldown: true },
      models: { chat: [primary, secondary, sticky] },
    });

    expect(
      await collectStream(streamText({ model: route("chat"), prompt: "first" }))
    ).toBe("sticky");
    primaryHealthy = true;
    stickyHealthy = false;
    vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));

    expect(
      await collectStream(
        streamText({ model: route("chat"), prompt: "second" })
      )
    ).toBe("recovered-primary");
    expect(primary.doStreamCalls).toHaveLength(2);
    expect(sticky.doStreamCalls).toHaveLength(2);
  });

  it("keeps the sticky head fixed while round-robin rotates its fallback tail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let stickyHealthy = true;
    const attempts: number[] = [];
    const sticky = new MockLanguageModelV4({
      doGenerate: () =>
        stickyHealthy
          ? Promise.resolve({
              content: [{ type: "text", text: "sticky" }],
              finishReason,
              usage,
              warnings: [],
            })
          : Promise.reject(new Error("sticky unavailable")),
    });
    const route = createRouter({
      fallback: { cooldown: true, selection: "round-robin" },
      models: {
        chat: [
          failingModel("primary unavailable"),
          failingModel("secondary unavailable"),
          sticky,
        ],
      },
      onAttempt: ({ index, outcome }) => {
        if (outcome === "failure") {
          attempts.push(index);
        }
      },
    });

    await generateText({ model: route("chat"), prompt: "establish sticky" });
    stickyHealthy = false;
    attempts.length = 0;
    vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));
    await expect(
      generateText({ model: route("chat"), prompt: "tail one" })
    ).rejects.toThrow();
    expect(attempts).toEqual([2, 0, 1]);

    attempts.length = 0;
    vi.setSystemTime(new Date("2026-01-01T00:00:47Z"));
    await expect(
      generateText({ model: route("chat"), prompt: "tail two" })
    ).rejects.toThrow();
    expect(attempts).toEqual([2, 1, 0]);
  });

  it("keeps a sticky stream head fixed while round-robin rotates its fallback tail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let stickyHealthy = true;
    const attempts: number[] = [];
    const healthyStream = streamingModel(["sticky"]);
    const sticky = new MockLanguageModelV4({
      doStream: (options) =>
        stickyHealthy
          ? healthyStream.doStream(options)
          : Promise.reject(new Error("sticky stream unavailable")),
    });
    const route = createRouter({
      fallback: { cooldown: true, selection: "round-robin" },
      models: {
        chat: [
          failingStreamModel("primary stream unavailable"),
          failingStreamModel("secondary stream unavailable"),
          sticky,
        ],
      },
      onAttempt: ({ index, outcome }) => {
        if (outcome === "failure") {
          attempts.push(index);
        }
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "sticky" }))
    ).resolves.toBe("sticky");
    stickyHealthy = false;
    attempts.length = 0;
    vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));
    await expect(asV4(route("chat")).doStream(genOptions)).rejects.toThrow();
    expect(attempts).toEqual([2, 0, 1]);

    attempts.length = 0;
    vi.setSystemTime(new Date("2026-01-01T00:00:47Z"));
    await expect(asV4(route("chat")).doStream(genOptions)).rejects.toThrow();
    expect(attempts).toEqual([2, 1, 0]);
  });

  it("keeps the sticky start position within the modality-filtered set", async () => {
    const a = failingModel("503 overloaded"); // text-only, fullIndex 0
    const b = okModel("b-text"); // text-only, fullIndex 1
    const c = okModel("c-image"); // text+image, fullIndex 2

    const route = createRouter({
      models: {
        chat: [
          { provider: () => a, model: "a", supports: ["text"] },
          { provider: () => b, model: "b", supports: ["text"] },
          { provider: () => c, model: "c", supports: ["text", "image"] },
        ],
      },
      fallback: { cooldown: true },
    });
    const routed = route("chat");

    // Text request: a fails, b serves -> survivor sticky index = 1 (b).
    await generateText({ model: routed, prompt: "text" });
    expect(b.doGenerateCalls).toHaveLength(1);

    // Image request: b (text-only) is filtered out; selection must fall to c
    // (the first surviving filtered candidate), not break on the stale index.
    const { text } = await generateText({
      model: routed,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "describe" }, imagePart],
        },
      ],
    });
    expect(text).toBe("c-image");
    expect(c.doGenerateCalls).toHaveLength(1);
    expect(a.doGenerateCalls).toHaveLength(1); // not retried for the image request
  });

  it("does NOT make a modality-forced candidate sticky over a healthy primary", async () => {
    const a = okModel("a-text"); // text-only, fullIndex 0, HEALTHY (never fails)
    const b = okModel("b-img"); // text+image, fullIndex 1

    const route = createRouter({
      models: {
        chat: [
          { provider: () => a, model: "a", supports: ["text"] },
          { provider: () => b, model: "b", supports: ["text", "image"] },
        ],
      },
      fallback: { cooldown: true },
    });
    const routed = route("chat");

    // Image request: only b is eligible (a is text-only); b serves WITHOUT a failing.
    await generateText({
      model: routed,
      messages: [
        { role: "user", content: [{ type: "text", text: "x" }, imagePart] },
      ],
    });
    expect(b.doGenerateCalls).toHaveLength(1);

    // Text request: the healthy primary `a` must still serve it — b must not have
    // become sticky just because it was the only image-capable candidate earlier.
    const { text } = await generateText({ model: routed, prompt: "hi" });
    expect(text).toBe("a-text");
    expect(a.doGenerateCalls).toHaveLength(1);
    expect(b.doGenerateCalls).toHaveLength(1);
  });
});
