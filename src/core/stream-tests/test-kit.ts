import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { defaultShouldRetryThisError } from "../retry";
import {
  type FallbackStreamArgs,
  type ResolvedEntry,
  wrapStreamResult,
} from "../stream";
import type { ClassifyFailure, OnRouterAttempt, OnRouterError } from "../types";

export const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
export const finishReason = { unified: "stop" as const, raw: "stop" };
export const callOptions = {
  prompt: [],
  includeRawChunks: false,
} as unknown as LanguageModelV4CallOptions;

/** A model whose stream emits exactly the given parts (in-band, closes normally). */
export function chunkModel(
  chunks: LanguageModelV4StreamPart[]
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock",
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks,
      }),
    }),
  });
}

/** A model that creates each part only when the consumer requests it. */
export function lazyChunkModel(
  factories: (() => LanguageModelV4StreamPart)[]
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock",
    doStream: () => {
      let index = 0;
      return Promise.resolve({
        stream: new ReadableStream({
          pull(controller) {
            const factory = factories[index];
            index += 1;
            if (factory === undefined) {
              controller.close();
              return;
            }
            controller.enqueue(factory());
          },
        }),
      });
    },
  });
}

/** A normal text stream emitting `parts` as deltas. */
export function textModel(parts: string[]): MockLanguageModelV4 {
  return chunkModel([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "1" },
    ...parts.map((delta) => ({ type: "text-delta" as const, id: "1", delta })),
    { type: "text-end", id: "1" },
    { type: "finish", finishReason, usage },
  ]);
}

/** Emits stream-start, then optional text deltas, then an in-band error part. */
export function errorPartModel(
  error: unknown,
  beforeText: string[] = []
): MockLanguageModelV4 {
  const head: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
  ];
  if (beforeText.length > 0) {
    head.push({ type: "text-start", id: "1" });
    for (const delta of beforeText) {
      head.push({ type: "text-delta", id: "1", delta });
    }
  }
  head.push({ type: "error", error });
  return chunkModel(head);
}

/** A model whose stream rejects on the next read after stream-start (transport drop). */
export function transportRejectModel(error: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock",
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
        },
        pull() {
          throw error;
        },
      }),
    }),
  });
}

export function resolved(model: LanguageModelV4, fullIndex = 0): ResolvedEntry {
  return { entry: model, model, fullIndex };
}

export interface DriveResult {
  error: unknown;
  parts: LanguageModelV4StreamPart[];
  text: string;
}

export async function drive(
  stream: ReadableStream<LanguageModelV4StreamPart>
): Promise<DriveResult> {
  const reader = stream.getReader();
  const parts: LanguageModelV4StreamPart[] = [];
  let error: unknown;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parts.push(value);
    }
  } catch (e) {
    error = e;
  }
  const text = parts
    .filter(
      (p): p is Extract<LanguageModelV4StreamPart, { type: "text-delta" }> =>
        p.type === "text-delta"
    )
    .map((p) => p.delta)
    .join("");
  return { parts, error, text };
}

export async function runFallback(
  models: MockLanguageModelV4[],
  opts: {
    abortSignal?: AbortSignal;
    acquireCandidate?: FallbackStreamArgs["acquireCandidate"];
    candidateAvailable?: FallbackStreamArgs["candidateAvailable"];
    candidateInFlight?: FallbackStreamArgs["candidateInFlight"];
    classifyFailure?: ClassifyFailure;
    concurrencyLimit?: FallbackStreamArgs["concurrencyLimit"];
    firstContentTimeout?: FallbackStreamArgs["firstContentTimeout"];
    isBudgetFailure?: FallbackStreamArgs["isBudgetFailure"];
    maxAttempts?: FallbackStreamArgs["maxAttempts"];
    onAttempt?: OnRouterAttempt;
    onRequestOutcome?: FallbackStreamArgs["onRequestOutcome"];
    prepareCandidate?: FallbackStreamArgs["prepareCandidate"];
    retryAfterOutput?: boolean;
    shouldRetry?: (e: unknown) => boolean;
    startAttemptStartedAt?: number;
    onError?: OnRouterError;
    releaseCandidate?: FallbackStreamArgs["releaseCandidate"];
    releaseProbeCandidate?: FallbackStreamArgs["releaseProbeCandidate"];
    strictStreamValidation?: boolean;
    waitForCandidate?: FallbackStreamArgs["waitForCandidate"];
  } = {}
): Promise<DriveResult> {
  const candidates = models.map((m, i) => resolved(m, i));
  const firstResult = await candidates[0].model.doStream(callOptions);
  const wrapped = wrapStreamResult({
    logicalId: "chat",
    candidates,
    startIndex: 0,
    startAttemptStartedAt: opts.startAttemptStartedAt,
    options: { ...callOptions, abortSignal: opts.abortSignal },
    firstResult,
    shouldRetry: opts.shouldRetry ?? defaultShouldRetryThisError,
    classifyFailure: opts.classifyFailure,
    retryAfterOutput: opts.retryAfterOutput ?? false,
    onError: opts.onError,
    onAttempt: opts.onAttempt,
    onRequestOutcome: opts.onRequestOutcome,
    prepareCandidate: opts.prepareCandidate,
    releaseCandidate: opts.releaseCandidate,
    releaseProbeCandidate: opts.releaseProbeCandidate,
    acquireCandidate: opts.acquireCandidate,
    candidateAvailable: opts.candidateAvailable,
    candidateInFlight: opts.candidateInFlight,
    concurrencyLimit: opts.concurrencyLimit,
    firstContentTimeout: opts.firstContentTimeout,
    isBudgetFailure: opts.isBudgetFailure,
    maxAttempts: opts.maxAttempts,
    strictStreamValidation: opts.strictStreamValidation,
    waitForCandidate: opts.waitForCandidate,
  });
  return drive(wrapped.stream);
}
