import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectModalities } from "./modality";
import { createRouter } from "./router";
import type { Modality } from "./types";

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
});

describe("createRouter — configuration errors", () => {
  it('throws "unknown model id" for an unregistered logical id', () => {
    const route = createRouter({ models: {} });
    expect(() => route("nope")).toThrow("unknown model id");
  });

  it("throws when a logical id maps to an empty candidate list", () => {
    const route = createRouter({ models: { chat: [] } });
    expect(() => route("chat")).toThrow("no provider entries");
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
});

// ---------------------------------------------------------------------------
// createRouter — lazy instantiation & caching
// ---------------------------------------------------------------------------
describe("createRouter — lazy instantiation & caching", () => {
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

// ---------------------------------------------------------------------------
// P0-B — error classification (non-retryable errors stop the fallback chain)
// ---------------------------------------------------------------------------
describe("createRouter — error classification (P0-B)", () => {
  it("STOPS on a non-retryable status (400) without trying the next candidate", async () => {
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
    ).rejects.toThrow("bad request");
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(0);
    expect(seen).toEqual([{ willRetry: false }]);
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
      shouldRetryThisError: () => false,
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).rejects.toThrow("overloaded");
    expect(secondary.doGenerateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// P0-C — error surfacing (AggregateError on multi-failure; original on single)
// ---------------------------------------------------------------------------
describe("createRouter — error surfacing (P0-C)", () => {
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
      cooldown: true,
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
      cooldown: true,
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
      cooldown: true,
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
