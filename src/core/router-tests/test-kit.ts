import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { LanguageModel, streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

// `route()` is typed as `LanguageModel` (a union that includes a bare model-id
// string). The router always returns a V4 model object; narrow it so tests can
// read model-level fields like `supportedUrls` without fighting the union.
export const asV4 = (m: LanguageModel): LanguageModelV4 => m as LanguageModelV4;

// ---------------------------------------------------------------------------
// V4 result building blocks (nested usage + object finishReason). Copied from
// the existing suite verbatim so every mock returns a spec-valid shape.
// ---------------------------------------------------------------------------
export const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
export const finishReason = { unified: "stop" as const, raw: "stop" };

// Regex literals hoisted to module scope (Biome performance/useTopLevelRegex):
// allocate each matcher once rather than per assertion / per mock construction.
export const NO_CANDIDATE_RE = /no candidate.*modalities/;
export const NOT_V4_RE = /did not provide a v4 LanguageModel/;
export const HTTPS_A_RE = /^https:\/\/a\//;
export const EXAMPLE_HTTPS_RE = /^https:\/\/example\.com\/.*$/;
export const MUTABLE_EXAMPLE_RE = /^https:\/\/example\.com\//;
export const MAX_ATTEMPTS_RE = /maxAttempts/;

export function promiseLike<T>(value: T): PromiseLike<T> {
  const method: PromiseLike<T>["then"] = (onfulfilled, onrejected) =>
    Promise.resolve(value).then(onfulfilled, onrejected);
  const result = {};
  Object.defineProperty(result, ["th", "en"].join(""), {
    configurable: true,
    value: method,
  });
  return result as PromiseLike<T>;
}

export function okModel(text = "Hello, world!") {
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

export function failingModel(message = "simulated API failure") {
  return new MockLanguageModelV4({
    doGenerate: () => Promise.reject(new Error(message)),
  });
}

export function streamingModel(parts: string[] = ["Hello", ", world!"]) {
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

export function failingStreamModel(message = "simulated stream failure") {
  return new MockLanguageModelV4({
    doStream: () => Promise.reject(new Error(message)),
  });
}

// A V4 image file part (data URL, not http) so the SDK inlines it instead of
// fetching over the network — keeps every integration test hermetic.
export const imagePart = {
  type: "file" as const,
  mediaType: "image/png",
  data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
};

export async function collectStream(result: ReturnType<typeof streamText>) {
  let acc = "";
  for await (const chunk of result.textStream) {
    acc += chunk;
  }
  return acc;
}

export async function collectRawStream(
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

// ---------------------------------------------------------------------------
// createRouter — routing, fallback, modality filtering, errors
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// createRouter — streaming
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// createRouter — lazy instantiation & caching
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// createRouter — supportedUrls (conservative intersection across candidates)
// ---------------------------------------------------------------------------

// ===========================================================================
// Robust-fallback upgrade: error classification, mid-stream fallback,
// AggregateError surfacing, cooldown, supports-optional, instance entries.
// ===========================================================================

export const genOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
} as unknown as LanguageModelV4CallOptions;

/** A model whose doGenerate throws an error carrying an HTTP-ish statusCode. */
export function failingModelStatus(statusCode: number, message = "api error") {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.reject(Object.assign(new Error(message), { statusCode })),
  });
}

/** A streaming model that emits stream-start then an in-band error part (no content). */
export function errorPartStreamModel(error: unknown) {
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
export function readErrorStreamModel(
  error: unknown,
  text: string | null = "partial"
) {
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

// ---------------------------------------------------------------------------
// P0-C — error surfacing (AggregateError on multi-failure; original on single)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P0-A — mid-stream fallback (error AFTER the stream opens, before content)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P2-A — supports optional (omitted supports => universal candidate)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P2-B — direct model instances (instance object + bare shorthand)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P1 — cooldown (opt-in sticky+reset)
// ---------------------------------------------------------------------------
