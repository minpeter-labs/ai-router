import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { defaultShouldRetryThisError } from "./retry";
import {
  createFallbackStream,
  discardLateStreamResult,
  type FallbackStreamArgs,
  type ResolvedEntry,
  wrapStreamResult,
} from "./stream";
import type {
  ClassifyFailure,
  FailureClassification,
  OnRouterAttempt,
  OnRouterError,
} from "./types";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const finishReason = { unified: "stop" as const, raw: "stop" };
const callOptions = {
  prompt: [],
  includeRawChunks: false,
} as unknown as LanguageModelV4CallOptions;

describe("discardLateStreamResult", () => {
  it("isolates hostile access and rejected cancellation", async () => {
    let thenReads = 0;
    const throwingResult = Object.defineProperty({}, "stream", {
      get() {
        throw new Error("stream unavailable");
      },
    });
    const throwingCancel = {
      stream: {
        cancel() {
          throw new Error("cancel unavailable");
        },
      },
    };
    const rejectingCancel = {
      stream: {
        cancel() {
          return Promise.reject(new Error("cancel rejected"));
        },
      },
    };
    const rejectingStream = {
      stream: Promise.reject(new Error("stream rejected")),
    };
    const rejectingCancelSlot = {
      stream: {
        cancel: Promise.reject(new Error("cancel slot rejected")),
      },
    };
    const extensionCancel = {
      stream: {
        cancel() {
          return Object.defineProperty({}, ["th", "en"].join(""), {
            get() {
              thenReads += 1;
              throw new Error("then extension must not run");
            },
          });
        },
      },
    };

    expect(() =>
      discardLateStreamResult(throwingResult as never)
    ).not.toThrow();
    expect(() =>
      discardLateStreamResult(throwingCancel as never)
    ).not.toThrow();
    expect(() =>
      discardLateStreamResult(rejectingCancel as never)
    ).not.toThrow();
    expect(() =>
      discardLateStreamResult(rejectingStream as never)
    ).not.toThrow();
    expect(() =>
      discardLateStreamResult(rejectingCancelSlot as never)
    ).not.toThrow();
    expect(() =>
      discardLateStreamResult(extensionCancel as never)
    ).not.toThrow();
    await Promise.resolve();
    expect(thenReads).toBe(0);
    await Promise.resolve();
  });

  it("consumes rejected metadata siblings on a discarded late result", async () => {
    const result = {
      request: {
        body: {
          prompt: Promise.reject(new Error("late request field rejected")),
        },
      },
      response: {
        headers: {
          "x-late": Promise.reject(new Error("late header rejected")),
        },
      },
      stream: {
        cancel: Promise.reject(new Error("late cancel slot rejected")),
      },
    };

    expect(() => discardLateStreamResult(result as never)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("cancels a late stream independently of hostile metadata", () => {
    const cancel = vi.fn();
    const result = {
      get request(): never {
        throw new Error("late request unavailable");
      },
      get response(): never {
        throw new Error("late response unavailable");
      },
      stream: { cancel },
    };

    expect(() => discardLateStreamResult(result as never)).not.toThrow();
    expect(cancel).toHaveBeenCalledWith("late stream result discarded");
  });

  it("starts late stream cancellation before bounded metadata cleanup", () => {
    const order: string[] = [];
    const result = {
      get request() {
        order.push("request");
        return { body: {} };
      },
      get response() {
        order.push("response");
        return { headers: {} };
      },
      stream: {
        cancel() {
          order.push("cancel");
        },
      },
    };

    discardLateStreamResult(result as never);

    expect(order).toEqual(["cancel", "request", "response"]);
  });
});

/** A model whose stream emits exactly the given parts (in-band, closes normally). */
function chunkModel(chunks: LanguageModelV4StreamPart[]): MockLanguageModelV4 {
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
function lazyChunkModel(
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
function textModel(parts: string[]): MockLanguageModelV4 {
  return chunkModel([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "1" },
    ...parts.map((delta) => ({ type: "text-delta" as const, id: "1", delta })),
    { type: "text-end", id: "1" },
    { type: "finish", finishReason, usage },
  ]);
}

/** Emits stream-start, then optional text deltas, then an in-band error part. */
function errorPartModel(
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
function transportRejectModel(error: unknown): MockLanguageModelV4 {
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

function resolved(model: LanguageModelV4, fullIndex = 0): ResolvedEntry {
  return { entry: model, model, fullIndex };
}

interface DriveResult {
  error: unknown;
  parts: LanguageModelV4StreamPart[];
  text: string;
}

async function drive(
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

async function runFallback(
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

describe("createFallbackStream (mid-stream fallback)", () => {
  it("passes a clean single stream through unchanged", async () => {
    const out = await runFallback([textModel(["Hello", ", world!"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("Hello, world!");
  });

  it("uses valid monotonic attempt tokens without a caller token source", async () => {
    const candidates = [
      resolved(errorPartModel(new Error("first failed")), 0),
      resolved(errorPartModel(new Error("second failed")), 1),
      resolved(textModel(["ok"]), 2),
    ];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const tokens: string[] = [];
    const now = vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    try {
      const wrapped = wrapStreamResult({
        candidates,
        firstResult,
        logicalId: "chat",
        onCandidateFailure: (_candidate, _failure, token) => {
          tokens.push(String(token));
          return;
        },
        onCandidateSuccess: (_candidate, token) => {
          tokens.push(String(token));
          return;
        },
        options: callOptions,
        retryAfterOutput: false,
        shouldRetry: defaultShouldRetryThisError,
        startIndex: 0,
      });

      await expect(drive(wrapped.stream)).resolves.toMatchObject({
        text: "ok",
      });
      expect(tokens).toHaveLength(3);
      expect(tokens.every((token) => token.split(":").length === 4)).toBe(true);
      expect(tokens[0] < tokens[1]).toBe(true);
      expect(tokens[1] < tokens[2]).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("falls back to local tokens when a caller token source is hostile", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["ok"]);
    const candidates = [resolved(primary, 0), resolved(survivor, 1)];
    const firstResult = await primary.doStream(callOptions);
    const observedTokens: string[] = [];
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      nextOrderingToken: () => {
        throw new Error("token source failed");
      },
      onCandidateFailure: (_candidate, _failure, token) => {
        observedTokens.push(String(token));
        return;
      },
      onCandidateSuccess: (_candidate, token) => {
        observedTokens.push(String(token));
        return;
      },
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
      startOrderingToken: Number.NaN,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(survivor.doStreamCalls).toHaveLength(1);
    expect(observedTokens).toHaveLength(2);
    expect(observedTokens.every((token) => token.split(":").length === 4)).toBe(
      true
    );
  });

  it("isolates capacity and probe cleanup failures during fallback", async () => {
    const candidates = [
      resolved(errorPartModel(new Error("primary failed")), 0),
      resolved(textModel(["ok"]), 1),
    ];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const capacityReleases: number[] = [];
    const probeReleases: number[] = [];
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      releaseCandidate: ({ fullIndex }) => {
        capacityReleases.push(fullIndex);
        throw new Error("capacity cleanup failed");
      },
      releaseProbeCandidate: ({ fullIndex }) => {
        probeReleases.push(fullIndex);
        throw new Error("probe cleanup failed");
      },
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(capacityReleases).toEqual([0, 1]);
    expect(probeReleases).toEqual([0, 1]);
  });

  it("consumes async capacity and probe cleanup results without probing thenables", async () => {
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      releaseCandidate: (() =>
        Promise.reject(new Error("async capacity release"))) as never,
      releaseProbeCandidate: (() => thenable) as never,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("isolates optional state hook failures from stream fallback", async () => {
    const candidates = [
      resolved(errorPartModel(new Error("primary failed")), 0),
      resolved(textModel(["ok"]), 1),
    ];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const calls: string[] = [];
    const fail = (name: string): never => {
      calls.push(name);
      throw new Error(`${name} failed`);
    };
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      isBudgetFailure: () => fail("budget-classification"),
      logicalId: "chat",
      onAdvance: () => fail("cooldown-advance"),
      onCandidateFailure: () => fail("health-failure"),
      onCandidateSuccess: () => fail("health-success"),
      onRequestOutcome: () => fail("budget-outcome"),
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({
      error: undefined,
      text: "ok",
    });
    expect(calls).toEqual([
      "budget-classification",
      "health-failure",
      "cooldown-advance",
      "health-success",
      "budget-outcome",
    ]);
  });

  it("consumes async optional state-hook results and requires a boolean budget result", async () => {
    const candidates = [
      resolved(errorPartModel(new Error("primary failed")), 0),
      resolved(textModel(["ok"]), 1),
    ];
    const firstResult = await candidates[0].model.doStream(callOptions);
    let observedOutcome: readonly unknown[] | undefined;
    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      isBudgetFailure: (() => thenable) as never,
      logicalId: "chat",
      onAdvance: (() =>
        Promise.reject(new Error("async cooldown advance"))) as never,
      onCandidateFailure: (() =>
        Promise.reject(new Error("async health failure"))) as never,
      onCandidateSuccess: (() =>
        Promise.reject(new Error("async health success"))) as never,
      onRequestOutcome: ((...args: unknown[]) => {
        observedOutcome = args;
        return Promise.reject(new Error("async budget outcome"));
      }) as never,
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(observedOutcome).toEqual([true, false, false]);
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes async operational control-hook results", async () => {
    for (const overrides of [
      {
        acquireCandidate: () => 1,
        candidateAvailable: (() =>
          Promise.reject(new Error("async availability"))) as never,
      },
      {
        acquireCandidate: () => 1,
        prepareCandidate: (() =>
          Promise.reject(new Error("async preparation"))) as never,
      },
      {
        acquireCandidate: (() =>
          Promise.reject(new Error("async admission"))) as never,
      },
    ]) {
      const primary = errorPartModel(new Error("primary failed"));
      const fallback = textModel(["must not open"]);
      const firstResult = await primary.doStream(callOptions);
      const wrapped = wrapStreamResult({
        candidates: [resolved(primary, 0), resolved(fallback, 1)],
        firstResult,
        logicalId: "chat",
        options: callOptions,
        retryAfterOutput: false,
        shouldRetry: defaultShouldRetryThisError,
        startIndex: 0,
        ...overrides,
      });

      await expect(drive(wrapped.stream)).resolves.toMatchObject({
        error: expect.anything(),
      });
      expect(fallback.doStreamCalls).toHaveLength(0);
    }

    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      nextOrderingToken: (() =>
        Promise.reject(new Error("async ordering token"))) as never,
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects non-boolean availability and preparation results", async () => {
    for (const overrides of [
      {
        acquireCandidate: () => 1,
        candidateAvailable: (() => ({})) as never,
      },
      {
        acquireCandidate: () => 1,
        prepareCandidate: (() => "yes") as never,
      },
    ]) {
      const primary = errorPartModel(new Error("primary failed"));
      const firstResult = await primary.doStream(callOptions);
      const wrapped = wrapStreamResult({
        candidates: [resolved(primary, 0), resolved(textModel(["unused"]), 1)],
        firstResult,
        logicalId: "chat",
        options: callOptions,
        retryAfterOutput: false,
        shouldRetry: defaultShouldRetryThisError,
        startIndex: 0,
        ...overrides,
      });

      await expect(drive(wrapped.stream)).resolves.toMatchObject({
        error: expect.anything(),
      });
    }
  });

  it("consumes and omits malformed diagnostic metric hook results", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const firstResult = await primary.doStream(callOptions);
    const events: Array<{ concurrencyLimit?: number; inFlight?: number }> = [];
    const wrapped = wrapStreamResult({
      acquireCandidate: () => undefined,
      candidateInFlight: (() =>
        Promise.reject(new Error("async in-flight metric"))) as never,
      candidates: [resolved(primary)],
      concurrencyLimit: (() =>
        Promise.reject(new Error("async limit metric"))) as never,
      firstResult,
      logicalId: "chat",
      onAttempt: (event) => events.push(event),
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await drive(wrapped.stream);

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.concurrencyLimit === undefined)).toBe(
      true
    );
    expect(events.every((event) => event.inFlight === undefined)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots known stream part accessors once", async () => {
    let delta = "stable";
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
    const statefulDelta = Object.defineProperties(
      {},
      {
        delta: once("delta", () => delta),
        id: once("id", () => "1"),
        providerMetadata: once("providerMetadata", () => ({ mock: {} })),
        type: once("type", () => "text-delta"),
        unknown: {
          enumerable: true,
          get() {
            throw new Error("unknown extension must not be read");
          },
        },
      }
    ) as LanguageModelV4StreamPart;
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      statefulDelta,
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);
    delta = "mutated";

    expect(out.text).toBe("stable");
    expect(Object.fromEntries(reads)).toEqual({
      delta: 1,
      id: 1,
      providerMetadata: 1,
      type: 1,
    });
  });

  it("snapshots stream warning indexes and fields exactly once", async () => {
    const reads = { index: 0, message: 0, type: 0 };
    const warning = Object.defineProperties(
      {},
      {
        message: {
          enumerable: true,
          get() {
            reads.message += 1;
            return "notice";
          },
        },
        type: {
          enumerable: true,
          get() {
            reads.type += 1;
            return "other";
          },
        },
      }
    );
    const warnings = new Proxy([warning], {
      get(target, property, receiver) {
        if (property === "0") {
          reads.index += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const model = chunkModel([
      { type: "stream-start", warnings } as never,
      { type: "text-start", id: "1" },
      { type: "text-delta", delta: "ok", id: "1" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);

    expect(out.error).toBeUndefined();
    expect(reads).toEqual({ index: 1, message: 1, type: 1 });
    expect(out.parts[0]).toEqual({
      type: "stream-start",
      warnings: [{ message: "notice", type: "other" }],
    });
  });

  it("snapshots nested stream finish and usage fields exactly once", async () => {
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
                reads.set(label, (reads.get(label) ?? 0) + 1);
                return value;
              },
            },
          ])
        )
      );
    const nestedUsage = once("usage", {
      inputTokens: once("input", usage.inputTokens),
      outputTokens: once("output", usage.outputTokens),
      raw: { stable: true },
    });
    const finish = once("part", {
      finishReason: once("finish", finishReason),
      providerMetadata: { mock: {} },
      type: "finish",
      usage: nestedUsage,
    }) as LanguageModelV4StreamPart;
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", delta: "ok", id: "1" },
      { type: "text-end", id: "1" },
      finish,
    ]);

    const out = await runFallback([model]);

    expect(out.error).toBeUndefined();
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(out.parts.at(-1)).toEqual({
      finishReason,
      providerMetadata: { mock: {} },
      type: "finish",
      usage: { ...usage, raw: { stable: true } },
    });
  });

  it("passes unknown future stream part objects through unchanged", async () => {
    const future = { payload: { value: 1 }, type: "future-part" } as never;
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      future,
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);

    expect(out.error).toBeUndefined();
    expect(out.parts).toContain(future);
  });

  it("captures an unknown future part type once while preserving identity", async () => {
    let reads = 0;
    const future = Object.defineProperties(
      { payload: { value: 1 } },
      {
        type: {
          enumerable: true,
          get() {
            reads += 1;
            return reads === 1 ? "future-part" : "error";
          },
        },
      }
    ) as never;
    const fallback = textModel(["must not run"]);
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      future,
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model, fallback]);

    expect(out.error).toBeUndefined();
    expect(out.parts).toContain(future);
    // The downstream test consumer also inspects the opaque value. Its later
    // getter results must not retroactively alter the router's captured type.
    expect(reads).toBeGreaterThan(1);
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it("captures reader methods once and preserves their receivers", async () => {
    const reads = { cancel: 0, getReader: 0, read: 0, releaseLock: 0 };
    const chunks: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", delta: "safe", id: "1" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ];
    let index = 0;
    const reader = {
      get cancel() {
        reads.cancel += 1;
        return function cancel(this: typeof reader) {
          expect(this).toBe(reader);
          return Promise.resolve();
        };
      },
      get read() {
        reads.read += 1;
        return function read(this: typeof reader) {
          expect(this).toBe(reader);
          const value = chunks[index];
          index += 1;
          return Promise.resolve(
            value === undefined ? { done: true, value } : { done: false, value }
          );
        };
      },
      get releaseLock() {
        reads.releaseLock += 1;
        return function releaseLock(this: typeof reader) {
          expect(this).toBe(reader);
          return Promise.reject(new Error("async release cleanup"));
        };
      },
    };
    const stream = {
      get getReader() {
        reads.getReader += 1;
        return function getReader(this: typeof stream) {
          expect(this).toBe(stream);
          return reader;
        };
      },
    };
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream }) as never,
    });

    const out = await runFallback([model]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("safe");
    expect(reads).toEqual({ cancel: 1, getReader: 1, read: 1, releaseLock: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes async stream and reader method slots before fallback", async () => {
    const asyncStream = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: Promise.reject(new Error("async stream slot")),
        }) as never,
    });
    const asyncReader = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => Promise.reject(new Error("async reader result")),
          },
        }) as never,
    });
    const asyncGetReader = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: Promise.reject(new Error("async getReader slot")),
          },
        }) as never,
    });
    const asyncMethods = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => ({
              cancel: Promise.reject(new Error("async cancel slot")),
              read: Promise.reject(new Error("async read slot")),
              releaseLock: Promise.reject(new Error("async release slot")),
            }),
          },
        }) as never,
    });

    const out = await runFallback([
      asyncStream,
      asyncGetReader,
      asyncReader,
      asyncMethods,
      textModel(["recovered"]),
    ]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots read-result fields once", async () => {
    let doneReads = 0;
    let valueReads = 0;
    const first = Object.defineProperties(
      {},
      {
        done: {
          get() {
            doneReads += 1;
            return false;
          },
        },
        value: {
          get() {
            valueReads += 1;
            return { type: "stream-start", warnings: [] };
          },
        },
      }
    );
    const results = [
      first,
      { done: false, value: { type: "text-start", id: "1" } },
      { done: false, value: { type: "text-delta", delta: "safe", id: "1" } },
      { done: false, value: { type: "text-end", id: "1" } },
      { done: false, value: { type: "finish", finishReason, usage } },
    ];
    const reader = {
      cancel: () => Promise.resolve(),
      read: () => Promise.resolve(results.shift() ?? { done: true }),
      releaseLock: () => undefined,
    };
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: { getReader: () => reader } }) as never,
    });

    const out = await runFallback([model]);
    expect(out.text).toBe("safe");
    expect(doneReads).toBe(1);
    expect(valueReads).toBe(1);
  });

  it("falls back on malformed read-result envelopes", async () => {
    const malformed = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => ({
              cancel: () => Promise.resolve(),
              read: () => Promise.resolve(42),
              releaseLock: () => undefined,
            }),
          },
        }) as never,
    });

    const out = await runFallback([malformed, textModel(["recovered"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
  });

  it("consumes async read-result fields without reading inactive accessors", async () => {
    const malformed = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => ({
              cancel: () => Promise.resolve(),
              read: () =>
                Promise.resolve({
                  done: Promise.reject(new Error("async read done")),
                  value: Promise.reject(new Error("async read value")),
                }),
              releaseLock: () => undefined,
            }),
          },
        }) as never,
    });

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));

    let valueReads = 0;
    const finished = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => ({
              cancel: () => Promise.resolve(),
              read: () =>
                Promise.resolve(
                  Object.defineProperty({ done: true }, "value", {
                    get() {
                      valueReads += 1;
                      throw new Error("inactive value must not be read");
                    },
                  })
                ),
              releaseLock: () => undefined,
            }),
          },
        }) as never,
    });
    await runFallback([finished, textModel(["empty fallback"])]);
    expect(valueReads).toBe(0);
  });

  it("does not consult arbitrary read thenable extensions", async () => {
    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    const malformed = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => ({
              cancel: () => Promise.resolve(),
              read: () => extension,
              releaseLock: () => undefined,
            }),
          },
        }) as never,
    });

    const out = await runFallback([malformed, textModel(["recovered"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(thenReads).toBe(0);
  });

  it("cleans up a partially captured malformed reader", async () => {
    let cancelCalls = 0;
    let releaseCalls = 0;
    const malformed = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            getReader: () => ({
              cancel() {
                cancelCalls += 1;
                return Promise.resolve();
              },
              get read() {
                throw new Error("read accessor unavailable");
              },
              releaseLock() {
                releaseCalls += 1;
              },
            }),
          },
        }) as never,
    });

    const out = await runFallback([malformed, textModel(["recovered"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(cancelCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it("cancels an opened stream when reader capture fails", async () => {
    const cancelled: unknown[] = [];
    const malformed = new MockLanguageModelV4({
      doStream: () => {
        const stream = {
          cancel(this: unknown, reason: unknown) {
            expect(this).toBe(stream);
            cancelled.push(reason);
            return Promise.reject(new Error("cleanup rejection"));
          },
          get getReader() {
            throw new Error("reader unavailable");
          },
        };
        return Promise.resolve({ stream } as never);
      },
    });

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("cancels a stream whose getReader returns an invalid value", async () => {
    let cancelCalls = 0;
    const malformed = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: {
            cancel() {
              cancelCalls += 1;
              return Promise.resolve();
            },
            getReader: () => null,
          },
        }) as never,
    });

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(cancelCalls).toBe(1);
  });

  it("isolates ordinary text deltas from later provider mutation", async () => {
    const delta: Extract<LanguageModelV4StreamPart, { type: "text-delta" }> = {
      delta: "stable",
      id: "1",
      type: "text-delta",
    };
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      delta,
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);
    delta.delta = "mutated";

    expect(out.text).toBe("stable");
    expect(out.parts).not.toContain(delta);
  });

  it("isolates throwing optional request and response metadata getters", async () => {
    const model = textModel(["ok"]);
    const candidates = [resolved(model)];
    const firstResult = await model.doStream(callOptions);
    Object.defineProperties(firstResult, {
      request: {
        get() {
          throw new Error("request metadata failed");
        },
      },
      response: {
        get() {
          throw new Error("response metadata failed");
        },
      },
    });
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.request).toBeUndefined();
    expect(wrapped.response).toBeUndefined();
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
  });

  it("consumes rejected Promise stream metadata without reading thenables", async () => {
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    firstResult.request = Promise.reject(
      new Error("async request metadata unsupported")
    ) as never;
    firstResult.response = Promise.reject(
      new Error("async response metadata unsupported")
    ) as never;
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.request).toBeUndefined();
    expect(wrapped.response).toBeUndefined();
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    let reads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        reads += 1;
        throw new Error("then extension must not run");
      },
    });
    const thenResult = await model.doStream(callOptions);
    thenResult.request = thenable as never;
    const thenWrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult: thenResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });
    await expect(drive(thenWrapped.stream)).resolves.toMatchObject({
      text: "ok",
    });
    expect(reads).toBe(0);
  });

  it("consumes every rejected stream response-header value", async () => {
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    firstResult.response = {
      headers: {
        "x-first": Promise.reject(new Error("async first stream header")),
        "x-second": Promise.reject(new Error("async second stream header")),
      },
    } as never;

    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("sanitizes nested stream request and response metadata", async () => {
    const model = textModel(["ok"]);
    const candidates = [resolved(model)];
    const firstResult = await model.doStream(callOptions);
    firstResult.request = Object.defineProperty({}, "body", {
      get() {
        throw new Error("request body failed");
      },
    });
    firstResult.response = {
      headers: Object.defineProperty({}, "x-hostile", {
        enumerable: true,
        get() {
          throw new Error("header failed");
        },
      }),
    } as never;
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.request).toBeUndefined();
    expect(wrapped.response).toBeUndefined();
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
  });

  it("copies special response-header keys without prototype mutation", async () => {
    const model = textModel(["ok"]);
    const candidates = [resolved(model)];
    const firstResult = await model.doStream(callOptions);
    const headers = Object.create(null) as Record<string, string>;
    Object.defineProperty(headers, "__proto__", {
      enumerable: true,
      value: "literal-header",
    });
    firstResult.response = { headers };
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    const copied = wrapped.response?.headers as Record<string, string>;
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.hasOwn(copied, "__proto__")).toBe(true);
    expect(Reflect.get(copied, "__proto__")).toBe("literal-header");
  });

  it("snapshots live stream metadata once and copies public containers", async () => {
    const reads = new Map<string, number>();
    const getter = (name: string, value: unknown) => ({
      enumerable: true,
      get() {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return value;
      },
    });
    const body = { opaque: true };
    const headers = Object.defineProperty(
      {},
      "x-provider",
      getter("header", "stable")
    );
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    Object.defineProperties(firstResult, {
      request: getter(
        "request",
        Object.defineProperty({}, "body", getter("body", body))
      ),
      response: getter(
        "response",
        Object.defineProperty({}, "headers", getter("headers", headers))
      ),
    });
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    const firstRequest = wrapped.request;
    const firstResponse = wrapped.response;
    if (firstResponse?.headers !== undefined) {
      firstResponse.headers["x-provider"] = "consumer mutation";
    }

    expect(wrapped.request).toEqual({ body });
    expect(wrapped.request).not.toBe(firstRequest);
    expect(wrapped.response).toEqual({
      headers: { "x-provider": "stable" },
    });
    expect(wrapped.response).not.toBe(firstResponse);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(reads.size).toBe(5);
  });

  it("drops invalid stream response-header names without reading values", async () => {
    let reads = 0;
    const model = textModel(["ok"]);
    const candidates = [resolved(model)];
    const firstResult = await model.doStream(callOptions);
    const headers = Object.defineProperty({}, "x".repeat(257), {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("must not be read");
      },
    });
    firstResult.response = { headers } as never;
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    expect(reads).toBe(0);
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
  });

  it("drops syntactically invalid stream headers before reading values", async () => {
    let reads = 0;
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    firstResult.response = {
      headers: Object.defineProperties(
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
            value: Promise.reject(new Error("async invalid header sibling")),
          },
        }
      ),
    } as never;
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    expect(reads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes stream header Promise siblings before a value getter throws", async () => {
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    firstResult.response = {
      headers: Object.defineProperties(
        {},
        {
          "x-first": {
            enumerable: true,
            get() {
              throw new Error("stream header getter failed");
            },
          },
          "x-later": {
            enumerable: true,
            value: Promise.reject(new Error("async stream header sibling")),
          },
        }
      ),
    } as never;
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("bounds stream header keys before reading any values", async () => {
    let reads = 0;
    const headers: Record<string, string> = {};
    for (let index = 0; index < 1025; index += 1) {
      Object.defineProperty(headers, `x-${index}`, {
        enumerable: true,
        get() {
          reads += 1;
          return "value";
        },
      });
    }
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    firstResult.response = { headers };
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("drops stream response-header values containing control characters", async () => {
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    firstResult.response = {
      headers: {
        "x-later": Promise.reject(new Error("async malformed-value sibling")),
        "x-value": "safe\r\ninjected",
      },
    } as never;
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("drops stream response headers above the aggregate size limit", async () => {
    const model = textModel(["ok"]);
    const candidates = [resolved(model)];
    const firstResult = await model.doStream(callOptions);
    firstResult.response = {
      headers: Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [
          `x-large-${index}`,
          "x".repeat(65_536),
        ])
      ),
    };
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
  });

  it("updates live request and response metadata to the fallback survivor", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["ok"]);
    const candidates = [resolved(primary), resolved(survivor, 1)];
    const firstResult = await primary.doStream(callOptions);
    firstResult.request = { body: "primary request" };
    firstResult.response = { headers: { "x-provider": "primary" } };
    survivor.doStream = async (options) => {
      const result = await textModel(["ok"]).doStream(options);
      return {
        ...result,
        request: { body: "survivor request" },
        response: { headers: { "x-provider": "survivor" } },
      };
    };
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.request).toEqual({ body: "primary request" });
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(wrapped.request).toEqual({ body: "survivor request" });
    expect(wrapped.response).toEqual({
      headers: { "x-provider": "survivor" },
    });
  });

  it("does not activate metadata from a fallback with a malformed reader", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const malformed = new MockLanguageModelV4({
      doStream: async () =>
        ({
          request: { body: "malformed request" },
          response: { headers: { "x-provider": "malformed" } },
          stream: {
            getReader() {
              observedDuringReaderValidation = wrapped.request;
              throw new Error("reader unavailable");
            },
          },
        }) as never,
    });
    const survivor = textModel(["ok"]);
    const candidates = [
      resolved(primary),
      resolved(malformed, 1),
      resolved(survivor, 2),
    ];
    const firstResult = await primary.doStream(callOptions);
    firstResult.request = { body: "primary request" };
    let observedDuringReaderValidation: unknown;
    let wrapped: ReturnType<typeof wrapStreamResult>;
    wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(observedDuringReaderValidation).toEqual({ body: "primary request" });
    expect(wrapped.request).not.toEqual({ body: "malformed request" });
  });

  it("includes initial stream opening time in attempt duration", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      vi.setSystemTime(100);
      const durations: number[] = [];
      await runFallback([textModel(["ok"])], {
        onAttempt: ({ durationMs, outcome }) => {
          if (outcome === "success") {
            durations.push(durationMs);
          }
        },
        startAttemptStartedAt: performance.now() - 60,
      });

      expect(durations).toEqual([60]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps attempt duration stable after wall-clock rollback", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      vi.setSystemTime(100);
      const durations: number[] = [];
      const startedAt = performance.now();
      vi.setSystemTime(0);
      await runFallback([textModel(["ok"])], {
        onAttempt: ({ durationMs, outcome }) => {
          if (outcome === "success") {
            durations.push(durationMs);
          }
        },
        startAttemptStartedAt: startedAt,
      });
      expect(durations).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a hanging open stream when the caller aborts", async () => {
    let cancelled = false;
    const hanging = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            cancel() {
              cancelled = true;
            },
          }),
        }),
    });
    const controller = new AbortController();
    const result = runFallback([hanging], { abortSignal: controller.signal });

    controller.abort(new Error("caller stopped stream"));

    await expect(result).resolves.toMatchObject({
      error: expect.objectContaining({ message: "caller stopped stream" }),
    });
    expect(cancelled).toBe(true);
  });

  it("does not miss an abort during stream-listener registration", async () => {
    const reason = new Error("stream aborted while subscribing");
    let aborted = false;
    const signal = {
      addEventListener() {
        aborted = true;
      },
      get aborted() {
        return aborted;
      },
      reason,
      removeEventListener() {
        // The synthetic signal does not retain listeners.
      },
    } as unknown as AbortSignal;

    const out = await runFallback([textModel(["must not emit"])], {
      abortSignal: signal,
    });
    expect(out.error).toBe(reason);
    expect(out.text).toBe("");
  });

  it("captures a repeatedly delivered stream abort reason once", async () => {
    let reasonReads = 0;
    let removals = 0;
    const reason = new Error("stream stopped repeatedly");
    const signal = {
      aborted: false,
      addEventListener(_name: string, listener: () => void) {
        listener();
        listener();
      },
      get reason() {
        reasonReads += 1;
        return reason;
      },
      removeEventListener() {
        removals += 1;
      },
    } as unknown as AbortSignal;

    const out = await runFallback([textModel(["must not emit"])], {
      abortSignal: signal,
    });
    expect(out.error).toBe(reason);
    expect(reasonReads).toBe(1);
    expect(removals).toBe(1);
  });

  it("routes stream-listener registration failure through cleanup", async () => {
    const failure = new Error("stream listener unavailable");
    const signal = {
      aborted: false,
      addEventListener() {
        throw failure;
      },
      removeEventListener() {
        throw new Error("stream listener cleanup unavailable");
      },
    } as unknown as AbortSignal;
    const released: number[] = [];

    const out = await runFallback([textModel(["must not emit"])], {
      abortSignal: signal,
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
    });
    expect(out.error).toBe(failure);
    expect(out.text).toBe("");
    expect(released).toEqual([0]);
  });

  it("preserves delivered stream abort when registration then throws", async () => {
    const reason = new Error("stream aborted during failed registration");
    let aborted = false;
    const signal = {
      addEventListener(_name: string, listener: () => void) {
        aborted = true;
        listener();
        throw new Error("stream listener registration failed");
      },
      get aborted() {
        return aborted;
      },
      reason,
      removeEventListener() {
        // Registration rollback has no retained listener.
      },
    } as unknown as AbortSignal;
    const released: number[] = [];

    const out = await runFallback([textModel(["must not emit"])], {
      abortSignal: signal,
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
    });
    expect(out.error).toBe(reason);
    expect(out.text).toBe("");
    expect(released).toEqual([0]);
  });

  it("preserves caller abort identity after an earlier stream failure", async () => {
    const hanging = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>(),
      }),
    });
    const controller = new AbortController();
    const pending = runFallback(
      [errorPartModel(new Error("primary failed")), hanging],
      { abortSignal: controller.signal }
    );
    while (hanging.doStreamCalls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const reason = new Error("caller stopped stream fallback");

    controller.abort(reason);

    const result = await pending;
    expect(result.error).toBe(reason);
  });

  it("stops reading upstream while the downstream queue is backpressured", async () => {
    const chunks: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      ...Array.from({ length: 20 }, (_, index) => ({
        type: "text-delta" as const,
        id: "1",
        delta: String(index),
      })),
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ];
    let pulls = 0;
    let position = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          pull(controller) {
            pulls += 1;
            const chunk = chunks[position];
            position += 1;
            if (chunk === undefined) {
              controller.close();
            } else {
              controller.enqueue(chunk);
            }
          },
        }),
      }),
    });
    const candidates = [resolved(model)];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pulls).toBeLessThan(chunks.length);

    const out = await drive(wrapped.stream);
    expect(out.text).toBe(
      Array.from({ length: 20 }, (_, i) => String(i)).join("")
    );
  });

  it("unblocks a backpressured pump and releases resources on consumer cancel", async () => {
    let upstreamCancelled = false;
    const released: number[] = [];
    const attempts: Array<{
      attempt?: number;
      inFlight?: number;
      limit?: number;
      outcome: string;
    }> = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "1" });
            controller.enqueue({ type: "text-delta", id: "1", delta: "one" });
            controller.enqueue({ type: "text-delta", id: "1", delta: "two" });
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
      }),
    });
    const candidates = [resolved(model)];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      concurrencyLimit: () => 2,
      options: callOptions,
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
      onAttempt: ({ attempt, concurrencyLimit, inFlight, outcome }) =>
        attempts.push({
          attempt,
          inFlight,
          limit: concurrencyLimit,
          outcome,
        }),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
      startInFlight: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapped.stream.cancel("consumer stopped");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upstreamCancelled).toBe(true);
    expect(released).toEqual([0]);
    expect(attempts).toEqual([
      { attempt: 1, inFlight: 1, limit: 2, outcome: "cancelled" },
    ]);
  });

  it("cancels an active reader once and releases its lock after cancellation settles", async () => {
    let cancelCalls = 0;
    let releaseCalls = 0;
    let resolveCancel: (() => void) | undefined;
    let seenCancelReason: unknown;
    const reader = {
      cancel(reason: unknown) {
        cancelCalls += 1;
        seenCancelReason = reason;
        return new Promise<void>((resolve) => {
          resolveCancel = resolve;
        });
      },
      read: () => new Promise<never>(() => undefined),
      releaseLock() {
        releaseCalls += 1;
      },
    };
    const model = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: { getReader: () => reader },
        }) as never,
    });
    const candidates = [resolved(model)];
    const firstResult = await model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapped.stream.cancel(
      Promise.reject(new Error("async consumer cancel reason"))
    );
    expect(cancelCalls).toBe(1);
    expect(releaseCalls).toBe(0);
    expect(seenCancelReason).toMatchObject({ name: "AbortError" });
    resolveCancel?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it("bounds reader retention when cancellation never settles", async () => {
    vi.useFakeTimers();
    try {
      let releaseCalls = 0;
      const reader = {
        cancel: () => new Promise<void>(() => undefined),
        read: () => new Promise<never>(() => undefined),
        releaseLock() {
          releaseCalls += 1;
        },
      };
      const model = new MockLanguageModelV4({
        doStream: async () =>
          ({
            stream: { getReader: () => reader },
          }) as never,
      });
      const candidates = [resolved(model)];
      const firstResult = await model.doStream(callOptions);
      const wrapped = wrapStreamResult({
        candidates,
        firstResult,
        logicalId: "chat",
        options: callOptions,
        retryAfterOutput: false,
        shouldRetry: defaultShouldRetryThisError,
        startIndex: 0,
      });

      await Promise.resolve();
      await wrapped.stream.cancel("consumer stopped");
      expect(releaseCalls).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(releaseCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not record success when cancellation occurs during part snapshot", async () => {
    const outcomes: string[] = [];
    const released: number[] = [];
    let successes = 0;
    let consumerReader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>;
    const cancellingPart = Object.defineProperty(
      { delta: "must not emit", id: "1" },
      "type",
      {
        get() {
          consumerReader
            .cancel("cancelled during snapshot")
            .catch(() => undefined);
          return "text-delta";
        },
      }
    ) as LanguageModelV4StreamPart;
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      cancellingPart,
    ]);
    const candidates = [resolved(model)];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      onAttempt: ({ outcome }) => outcomes.push(outcome),
      onCandidateSuccess: () => {
        successes += 1;
        return;
      },
      options: callOptions,
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    consumerReader = wrapped.stream.getReader();
    await Promise.allSettled([consumerReader.read()]);
    expect(outcomes).toEqual(["cancelled"]);
    expect(successes).toBe(0);
    expect(released).toEqual([0]);
  });

  it("aborts an in-progress fallback open on consumer cancel", async () => {
    let fallbackAborted = false;
    const released: number[] = [];
    const failed: number[] = [];
    const outcomes: string[] = [];
    const primary = errorPartModel(new Error("primary failed"));
    const fallback = new MockLanguageModelV4({
      doStream: (options) =>
        new Promise((_, reject) => {
          options.abortSignal?.addEventListener(
            "abort",
            () => {
              fallbackAborted = true;
              reject(options.abortSignal?.reason);
            },
            { once: true }
          );
        }),
    });
    const candidates = [resolved(primary, 0), resolved(fallback, 1)];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      acquireCandidate: () => 1,
      candidates,
      firstResult,
      logicalId: "chat",
      onAttempt: ({ outcome }) => outcomes.push(outcome),
      onCandidateFailure: ({ fullIndex }) => {
        failed.push(fullIndex);
        return;
      },
      options: callOptions,
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
      startInFlight: 1,
    });
    const reader = wrapped.stream.getReader();
    const pendingRead = reader.read();
    while (fallback.doStreamCalls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await reader.cancel("consumer stopped opening fallback");
    await pendingRead;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fallbackAborted).toBe(true);
    expect(released).toEqual([0, 1]);
    expect(failed).toEqual([0]);
    expect(outcomes).toEqual(["failure", "cancelled"]);
  });

  it("removes fallback capacity waiting on consumer cancel", async () => {
    let waitStarted = false;
    let waitAborted = false;
    const released: number[] = [];
    const releasedProbes: Array<string | undefined> = [];
    const outcomes: boolean[] = [];
    const attempts: Array<{
      attempt?: number;
      inFlight?: number;
      index: number;
      limit?: number;
      outcome: string;
    }> = [];
    const primary = errorPartModel(new Error("primary failed"));
    const fallback = textModel(["must not open"]);
    const candidates = [resolved(primary, 0), resolved(fallback, 1)];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      acquireCandidate: () => undefined,
      candidateInFlight: () => 2,
      candidates,
      concurrencyLimit: () => 2,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      onAttempt: ({ attempt, concurrencyLimit, inFlight, index, outcome }) =>
        attempts.push({
          attempt,
          inFlight,
          index,
          limit: concurrencyLimit,
          outcome,
        }),
      onRequestOutcome: (success) => outcomes.push(success),
      prepareCandidate: (candidate) => {
        candidate.probeLease = {
          key: `local-${candidate.fullIndex}`,
          probingUntil: 123,
          source: "local",
        };
        return true;
      },
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
      releaseProbeCandidate: (candidate) => {
        releasedProbes.push(candidate.probeLease?.source);
        candidate.probeLease = undefined;
      },
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
      startInFlight: 1,
      waitForCandidate: (_candidate, signal) =>
        new Promise((_, reject) => {
          waitStarted = true;
          signal?.addEventListener(
            "abort",
            () => {
              waitAborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
        }),
    });
    const reader = wrapped.stream.getReader();
    const pendingRead = reader.read();
    while (!waitStarted) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await reader.cancel("consumer stopped waiting");
    await pendingRead;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(waitAborted).toBe(true);
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(released).toEqual([0]);
    expect(releasedProbes).toEqual([undefined, "local"]);
    expect(outcomes).toEqual([]);
    expect(attempts).toEqual([
      { attempt: 1, inFlight: 1, index: 0, limit: 2, outcome: "failure" },
      {
        attempt: undefined,
        inFlight: 2,
        index: 1,
        limit: 2,
        outcome: "cancelled",
      },
    ]);
  });

  it("reports consumer cancellation during fallback backoff", async () => {
    const attempts: Array<{
      attempt?: number;
      inFlight?: number;
      index: number;
      limit?: number;
      outcome: string;
    }> = [];
    const released: number[] = [];
    const primary = errorPartModel(new Error("primary failed"));
    const fallback = textModel(["must not open"]);
    const candidates = [resolved(primary, 0), resolved(fallback, 1)];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      backoff: 1000,
      candidateInFlight: () => 0,
      candidates,
      concurrencyLimit: () => 2,
      firstResult,
      logicalId: "chat",
      onAttempt: ({ attempt, concurrencyLimit, inFlight, index, outcome }) =>
        attempts.push({
          attempt,
          inFlight,
          index,
          limit: concurrencyLimit,
          outcome,
        }),
      options: callOptions,
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
      startInFlight: 1,
    });
    const reader = wrapped.stream.getReader();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    const pendingRead = reader.read();
    while (!released.includes(0)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    try {
      await reader.cancel("consumer stopped backoff");
      await pendingRead;
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      random.mockRestore();
    }

    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(attempts).toEqual([
      { attempt: 1, inFlight: 1, index: 0, limit: 2, outcome: "failure" },
      {
        attempt: undefined,
        inFlight: 0,
        index: 1,
        limit: 2,
        outcome: "cancelled",
      },
    ]);
  });

  it("falls back when a stream closes before content and without finish", async () => {
    const incomplete = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
    ]);
    const out = await runFallback([incomplete, textModel(["fallback"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("fallback");
  });

  it("falls back when a stream finishes without any output", async () => {
    const empty = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "finish", finishReason, usage },
    ]);
    const out = await runFallback([empty, textModel(["fallback"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("fallback");
    expect(out.parts.filter(({ type }) => type === "finish")).toHaveLength(1);
  });

  it("bounds buffered framing before output and falls back on overflow", async () => {
    const noisy = chunkModel(
      Array.from({ length: 1025 }, () => ({
        type: "stream-start" as const,
        warnings: [],
      }))
    );
    const out = await runFallback([noisy, textModel(["fallback"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("fallback");
    expect(noisy.doStreamCalls).toHaveLength(1);
  });

  it("bounds cumulative framing provider-metadata structure", async () => {
    const metadata = () => ({
      mock: { items: Array.from({ length: 6000 }, () => ({})) },
    });
    const noisy = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1", providerMetadata: metadata() },
      { type: "text-start", id: "2", providerMetadata: metadata() },
    ]);

    const out = await runFallback([noisy, textModel(["fallback"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("fallback");
    expect(
      out.parts.some(
        (part) =>
          part.type === "text-start" &&
          part.providerMetadata?.mock !== undefined
      )
    ).toBe(false);
  });

  it("treats whitespace-only streamed text as empty", async () => {
    const empty = textModel(["  ", "\n"]);
    const out = await runFallback([empty, textModel(["fallback"])]);

    expect(out.text).toBe("fallback");
  });

  it("surfaces an incomplete stream after content instead of silently succeeding", async () => {
    const incomplete = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "partial" },
    ]);
    const seen: unknown[] = [];
    const out = await runFallback([incomplete], {
      onError: ({ error }) => seen.push(error),
    });

    expect(out.text).toBe("partial");
    expect(out.error).toMatchObject({ code: "incomplete_model_stream" });
    expect(seen).toHaveLength(1);
  });

  it("isolates attempt failure payload mutation from terminal surfacing", async () => {
    const first = new Error("retry first");
    const terminal = new Error("terminal request failure");
    const out = await runFallback(
      [errorPartModel(first), errorPartModel(terminal)],
      {
        classifyFailure: (error) =>
          error === terminal
            ? { retryable: false, scope: "request" }
            : { retryable: true, scope: "transient" },
        onAttempt: ({ failure, index }) => {
          if (index === 1 && failure !== undefined) {
            failure.scope = "transient";
            failure.statusCode = 503;
          }
        },
      }
    );

    expect(out.error).toBe(terminal);
    expect(out.error).not.toBeInstanceOf(AggregateError);
  });

  it("isolates health and budget hook classification mutation from retry", async () => {
    for (const hook of ["budget", "health"] as const) {
      const primaryError = new Error(`${hook} primary failure`);
      const observed: Array<FailureClassification | undefined> = [];
      const out = await runFallback(
        [errorPartModel(primaryError), textModel(["recovered"])],
        {
          classifyFailure: () => ({
            retryable: true,
            scope: "transient",
            statusCode: 503,
          }),
          ...(hook === "budget"
            ? {
                isBudgetFailure: (failure: FailureClassification) => {
                  failure.cooldownMs = Promise.reject(
                    new Error("async budget cooldown")
                  ) as never;
                  failure.retryAfterMs = Promise.reject(
                    new Error("async budget retry-after")
                  ) as never;
                  failure.retryable = Promise.reject(
                    new Error("async budget retryable")
                  ) as never;
                  failure.scope = Promise.reject(
                    new Error("async budget scope")
                  ) as never;
                  failure.statusCode = Promise.reject(
                    new Error("async budget status")
                  ) as never;
                  return true;
                },
              }
            : {
                onCandidateFailure: (
                  _candidate: ResolvedEntry,
                  failure: FailureClassification
                ) => {
                  failure.cooldownMs = Promise.reject(
                    new Error("async health cooldown")
                  ) as never;
                  failure.retryAfterMs = Promise.reject(
                    new Error("async health retry-after")
                  ) as never;
                  failure.retryable = Promise.reject(
                    new Error("async health retryable")
                  ) as never;
                  failure.scope = Promise.reject(
                    new Error("async health scope")
                  ) as never;
                  failure.statusCode = Promise.reject(
                    new Error("async health status")
                  ) as never;
                },
              }),
          onAttempt: ({ failure }) => observed.push(failure),
        }
      );

      expect(out.error).toBeUndefined();
      expect(out.text).toBe("recovered");
      expect(observed[0]).toMatchObject({
        retryable: true,
        scope: "transient",
        statusCode: 503,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it("isolates health hook candidate ownership mutation from release", async () => {
    const releases: number[] = [];
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["recovered"]);
    const firstResult = await primary.doStream(callOptions);
    const wrapped = wrapStreamResult({
      candidates: [resolved(primary, 0), resolved(survivor, 1)],
      firstResult,
      logicalId: "chat",
      onCandidateFailure: (candidate) => {
        candidate.fullIndex = 100;
      },
      onCandidateSuccess: (candidate) => {
        candidate.fullIndex = 101;
      },
      options: callOptions,
      releaseCandidate: (candidate) => releases.push(candidate.fullIndex),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({
      text: "recovered",
    });
    expect(releases).toEqual([0, 1]);
  });

  it("omits invalid candidate health transition hook results", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["recovered"]);
    const firstResult = await primary.doStream(callOptions);
    const transitions: unknown[] = [];
    let thenReads = 0;
    const invalidTransition = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("transition then extension must not run");
      },
    });
    const wrapped = wrapStreamResult({
      candidates: [resolved(primary, 0), resolved(survivor, 1)],
      firstResult,
      logicalId: "chat",
      onAttempt: ({ healthTransition }) => transitions.push(healthTransition),
      onCandidateFailure: () => "invalid-transition" as never,
      onCandidateSuccess: () => invalidTransition as never,
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({
      text: "recovered",
    });
    expect(transitions).toEqual([undefined, undefined]);
    expect(thenReads).toBe(0);
  });

  it("isolates read-only control hook candidate mutation", async () => {
    const releases: number[] = [];
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["recovered"]);
    const firstResult = await primary.doStream(callOptions);
    const wrapped = wrapStreamResult({
      acquireCandidate: (candidate) => {
        expect(candidate.fullIndex).toBe(1);
        candidate.fullIndex = 101;
        return 1;
      },
      candidateAvailable: (candidate) => {
        expect(candidate.fullIndex).toBe(1);
        candidate.fullIndex = 100;
        return true;
      },
      candidateInFlight: (candidate) => {
        candidate.fullIndex = 102;
        return 0;
      },
      candidates: [resolved(primary, 0), resolved(survivor, 1)],
      concurrencyLimit: (candidate) => {
        candidate.fullIndex = 103;
        return 1;
      },
      firstResult,
      logicalId: "chat",
      onAttempt: () => undefined,
      options: callOptions,
      releaseCandidate: (candidate) => releases.push(candidate.fullIndex),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({
      text: "recovered",
    });
    expect(survivor.doStreamCalls).toHaveLength(1);
    expect(releases).toEqual([0, 1]);
  });

  it("isolates admission wait hook candidate mutation", async () => {
    const releases: number[] = [];
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["recovered"]);
    const firstResult = await primary.doStream(callOptions);
    const wrapped = wrapStreamResult({
      acquireCandidate: () => undefined,
      candidates: [resolved(primary, 0), resolved(survivor, 1)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      releaseCandidate: (candidate) => releases.push(candidate.fullIndex),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
      waitForCandidate: (candidate) => {
        expect(candidate.fullIndex).toBe(1);
        candidate.fullIndex = 100;
        return Promise.resolve(1);
      },
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({
      text: "recovered",
    });
    expect(releases).toEqual([0, 1]);
  });

  it("does not replace a provider failure with a hostile aborted getter", async () => {
    const first = new Error("retry this provider failure");
    let abortReads = 0;
    const signal = {
      addEventListener() {
        // The synthetic signal remains active.
      },
      get aborted() {
        abortReads += 1;
        if (abortReads >= 3) {
          throw new Error("aborted getter unavailable");
        }
        return false;
      },
      removeEventListener() {
        // The synthetic signal does not retain listeners.
      },
    } as unknown as AbortSignal;

    const out = await runFallback(
      [errorPartModel(first), textModel(["fallback"])],
      {
        abortSignal: signal,
        classifyFailure: (error) => ({
          retryable: error === first,
          scope: "transient",
        }),
      }
    );

    expect(out.text).toBe("fallback");
    expect(out.error).toBeUndefined();
    expect(abortReads).toBeGreaterThanOrEqual(3);
  });

  it("reports a post-output in-band error through onError", async () => {
    const failure = new Error("connection dropped");
    const seen: unknown[] = [];
    await runFallback([errorPartModel(failure, ["partial"])], {
      onError: ({ error }) => seen.push(error),
    });

    expect(seen).toEqual([failure]);
  });

  it("releases admission after a post-output in-band error", async () => {
    const released: number[] = [];
    await runFallback([errorPartModel(new Error("dropped"), ["partial"])], {
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
    });

    expect(released).toEqual([0]);
  });

  it("cancels a failed upstream before opening its fallback", async () => {
    let cancelled = false;
    const failed = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "error", error: new Error("failed") });
          },
          cancel() {
            cancelled = true;
          },
        }),
      }),
    });

    const out = await runFallback([failed, textModel(["fallback"])]);
    expect(out.text).toBe("fallback");
    expect(cancelled).toBe(true);
  });

  it("falls back on an invalid block lifecycle in strict mode", async () => {
    const invalid = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-delta", id: "missing", delta: "bad" },
    ]);
    const out = await runFallback([invalid, textModel(["valid"])], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("valid");
  });

  it("requires a final tool-call after streamed tool input in strict mode", async () => {
    const incompleteTool = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "call-1", toolName: "search" },
      { type: "tool-input-delta", id: "call-1", delta: '{"q":"x"}' },
      { type: "tool-input-end", id: "call-1" },
      { type: "finish", finishReason, usage },
    ]);
    const out = await runFallback([incompleteTool, textModel(["valid"])], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("valid");
  });

  it("bounds buffered strict tool-input text before output", async () => {
    const oversizedTool = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "call-1", toolName: "search" },
      { type: "tool-input-delta", id: "call-1", delta: "x".repeat(1_048_577) },
    ]);
    const out = await runFallback([oversizedTool, textModel(["valid"])], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("valid");
  });

  it("accepts a complete streamed tool call in strict mode", async () => {
    const completeTool = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "call-1", toolName: "search" },
      { type: "tool-input-delta", id: "call-1", delta: '{"q":"x"}' },
      { type: "tool-input-end", id: "call-1" },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "search",
        input: '{"q":"x"}',
      },
      { type: "finish", finishReason, usage },
    ]);
    const out = await runFallback([completeTool], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.parts.some((part) => part.type === "tool-call")).toBe(true);
  });

  it("bounds strict tool-call tracking after output commits", async () => {
    const excessive = chunkModel([
      { type: "stream-start", warnings: [] },
      ...Array.from({ length: 1025 }, (_, index) => ({
        input: "{}",
        toolCallId: `call-${index}`,
        toolName: "search",
        type: "tool-call" as const,
      })),
    ]);
    const fallback = textModel(["must not run"]);

    const out = await runFallback([excessive, fallback], {
      strictStreamValidation: true,
    });

    expect(out.error).toMatchObject({ code: "invalid_model_stream" });
    expect(out.parts.filter((part) => part.type === "tool-call")).toHaveLength(
      1024
    );
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it("bounds aggregate JSON containers across a committed stream", async () => {
    const excessiveModel = () =>
      chunkModel([
        { type: "stream-start", warnings: [] },
        ...Array.from({ length: 6 }, (_, index) => ({
          input: "{}",
          providerMetadata: {
            mock: { items: Array.from({ length: 9000 }, () => ({})) },
          },
          toolCallId: `call-${index}`,
          toolName: "search",
          type: "tool-call" as const,
        })),
      ]);

    const fallback = textModel(["must not run"]);
    const stopped = await runFallback([excessiveModel(), fallback]);
    expect(stopped.error).toMatchObject({ code: "invalid_model_stream" });
    expect(
      stopped.parts.filter((part) => part.type === "tool-call")
    ).toHaveLength(5);
    expect(fallback.doStreamCalls).toHaveLength(0);

    const retried = await runFallback(
      [excessiveModel(), textModel(["recovered"])],
      { retryAfterOutput: true }
    );
    expect(retried.error).toBeUndefined();
    expect(retried.text).toBe("recovered");
  });

  it("bounds aggregate JSON string and key characters across a stream", async () => {
    const payload = "x".repeat(1_000_000);
    const excessive = chunkModel([
      { type: "stream-start", warnings: [] },
      ...Array.from({ length: 5 }, (_, index) => ({
        input: "{}",
        providerMetadata: { mock: { payload } },
        toolCallId: `call-${index}`,
        toolName: "search",
        type: "tool-call" as const,
      })),
    ]);
    const fallback = textModel(["must not run"]);

    const out = await runFallback([excessive, fallback]);

    expect(out.error).toMatchObject({ code: "invalid_model_stream" });
    expect(out.parts.filter((part) => part.type === "tool-call")).toHaveLength(
      4
    );
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it("bounds stream metadata while leaving model body text unrestricted", async () => {
    const body = "x".repeat(100_000);
    const valid = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", delta: body, id: "1" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);
    const validOut = await runFallback([valid]);
    expect(validOut.error).toBeUndefined();
    expect(validOut.text).toBe(body);

    const title = "t".repeat(65_536);
    const excessive = chunkModel([
      { type: "stream-start", warnings: [] },
      ...Array.from({ length: 65 }, (_, index) => ({
        id: `source-${index}`,
        sourceType: "url" as const,
        title,
        type: "source" as const,
        url: "https://example.com/source",
      })),
    ]);
    const fallback = textModel(["must not run"]);

    const out = await runFallback([excessive, fallback]);

    expect(out.error).toMatchObject({ code: "invalid_model_stream" });
    expect(
      out.parts.filter((part) => part.type === "source").length
    ).toBeLessThan(65);
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it("allows empty optional streamed metadata strings", async () => {
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      {
        id: "source",
        sourceType: "url",
        title: "",
        type: "source",
        url: "https://example.com/source",
      },
      {
        finishReason: { raw: "", unified: "stop" },
        type: "finish",
        usage,
      },
    ]);

    const out = await runFallback([model]);

    expect(out.error).toBeUndefined();
    expect(out.parts.some((part) => part.type === "source")).toBe(true);
  });

  it("rejects duplicate stream-start parts in strict mode", async () => {
    const duplicateStart = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "bad" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);
    const out = await runFallback([duplicateStart, textModel(["valid"])], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("valid");
  });

  it("requires stream-start before content in strict mode", async () => {
    const missingStart = chunkModel([
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "bad" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);
    const out = await runFallback([missingStart, textModel(["valid"])], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("valid");
  });

  it("rejects duplicate response metadata in strict mode", async () => {
    const duplicateMetadata = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "one" },
      { type: "response-metadata", id: "two" },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "bad" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);
    const out = await runFallback([duplicateMetadata, textModel(["valid"])], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("valid");
  });

  it("reports willRetry false when concurrency admission fails", async () => {
    const decisions: boolean[] = [];
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["blocked"])],
      {
        acquireCandidate: () => undefined,
        onError: ({ willRetry }) => decisions.push(willRetry ?? false),
      }
    );

    expect(out.error).toBeDefined();
    expect(decisions).toEqual([false]);
  });

  it("reports stream concurrency state with the same attempt schema", async () => {
    const events: Array<{
      inFlight?: number;
      limit?: number;
      reason?: string;
    }> = [];
    await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["blocked"])],
      {
        acquireCandidate: () => undefined,
        candidateInFlight: () => 2,
        concurrencyLimit: () => 2,
        onAttempt: ({ concurrencyLimit, inFlight, reason }) =>
          events.push({ inFlight, limit: concurrencyLimit, reason }),
      }
    );

    expect(events).toContainEqual({
      inFlight: 2,
      limit: 2,
      reason: "concurrency",
    });
  });

  it("does not report a waited and admitted stream candidate as skipped", async () => {
    const events: Array<{
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["waited"])],
      {
        acquireCandidate: () => undefined,
        onAttempt: ({ index, outcome, reason }) =>
          events.push({ index, outcome, reason }),
        waitForCandidate: () => Promise.resolve(1),
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("waited");
    expect(events).toContainEqual({
      index: 1,
      outcome: "success",
      reason: undefined,
    });
    expect(events).not.toContainEqual({
      index: 1,
      outcome: "skipped",
      reason: "concurrency",
    });
  });

  it("reports a stream candidate as skipped when capacity waiting expires", async () => {
    const skipped: Array<{ index: number; reason?: string }> = [];
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["blocked"])],
      {
        acquireCandidate: () => undefined,
        onAttempt: ({ index, outcome, reason }) => {
          if (outcome === "skipped") {
            skipped.push({ index, reason });
          }
        },
        waitForCandidate: () => Promise.resolve(undefined),
      }
    );

    expect(out.error).toBeDefined();
    expect(skipped).toEqual([{ index: 1, reason: "concurrency" }]);
  });

  it("orders deferred stream skips after their triggering failure", async () => {
    const events: Array<{
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["saturated"]),
        textModel(["cooling"]),
        textModel(["waited"]),
      ],
      {
        acquireCandidate: () => undefined,
        candidateAvailable: ({ fullIndex }) => fullIndex !== 2,
        onAttempt: ({ index, outcome, reason }) =>
          events.push({ index, outcome, reason }),
        waitForCandidate: () => Promise.resolve(1),
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("waited");
    expect(events).toEqual([
      { index: 0, outcome: "failure", reason: undefined },
      { index: 1, outcome: "skipped", reason: "concurrency" },
      { index: 2, outcome: "skipped", reason: "cooldown" },
      { index: 3, outcome: "success", reason: undefined },
    ]);
  });

  it("isolates a throwing deferred skip hook from later events", async () => {
    const events: Array<{ index: number; outcome: string; reason?: string }> =
      [];
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["saturated"]),
        textModel(["cooling"]),
        textModel(["waited"]),
      ],
      {
        acquireCandidate: () => undefined,
        candidateAvailable: ({ fullIndex }) => fullIndex !== 2,
        onAttempt: ({ index, outcome, reason }) => {
          events.push({ index, outcome, reason });
          if (index === 1 && outcome === "skipped") {
            throw new Error("deferred metrics unavailable");
          }
        },
        waitForCandidate: () => Promise.resolve(1),
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("waited");
    expect(events).toEqual([
      { index: 0, outcome: "failure", reason: undefined },
      { index: 1, outcome: "skipped", reason: "concurrency" },
      { index: 2, outcome: "skipped", reason: "cooldown" },
      { index: 3, outcome: "success", reason: undefined },
    ]);
  });

  it("snapshots deferred concurrency metrics before admission state changes", async () => {
    let inFlight = 2;
    let limit = 2;
    const skipped: Array<{ inFlight?: number; limit?: number }> = [];
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["saturated"]),
        textModel(["waited"]),
      ],
      {
        acquireCandidate: () => undefined,
        candidateInFlight: () => inFlight,
        concurrencyLimit: () => limit,
        onAttempt: ({ concurrencyLimit, inFlight: seen, outcome }) => {
          if (outcome === "skipped") {
            skipped.push({ inFlight: seen, limit: concurrencyLimit });
          }
        },
        waitForCandidate: () => {
          inFlight = 0;
          limit = 1;
          return Promise.resolve(1);
        },
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("waited");
    expect(skipped).toEqual([{ inFlight: 2, limit: 2 }]);
  });

  it("orders max-attempt skips after the failure that exhausted the budget", async () => {
    const events: Array<{
      attempt?: number;
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["second"]),
        textModel(["third"]),
      ],
      {
        maxAttempts: 1,
        onAttempt: ({ attempt, index, outcome, reason }) =>
          events.push({ attempt, index, outcome, reason }),
      }
    );

    expect(out.error).toMatchObject({ message: "primary failed" });
    expect(events).toEqual([
      {
        attempt: 1,
        index: 0,
        outcome: "failure",
        reason: undefined,
      },
      {
        attempt: undefined,
        index: 1,
        outcome: "skipped",
        reason: "max-attempts",
      },
      {
        attempt: undefined,
        index: 2,
        outcome: "skipped",
        reason: "max-attempts",
      },
    ]);
  });

  it("bounds and completely flushes maximum-candidate skip observability", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const unattempted = textModel(["must not run"]);
    const models = Array.from({ length: 10_000 }, (_, index) =>
      index === 0 ? primary : unattempted
    );
    let events = 0;
    let rejectedHooks = 0;
    let finalEvent:
      | { attempt?: number; index: number; outcome: string; reason?: string }
      | undefined;

    const out = await runFallback(models, {
      maxAttempts: 1,
      onAttempt: ({ attempt, index, outcome, reason }) => {
        events += 1;
        finalEvent = { attempt, index, outcome, reason };
        if (index % 1000 === 0) {
          rejectedHooks += 1;
          return Promise.reject(new Error("sampled metrics rejection"));
        }
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(out.error).toMatchObject({ message: "primary failed" });
    expect(events).toBe(10_000);
    expect(rejectedHooks).toBe(10);
    expect(finalEvent).toEqual({
      attempt: undefined,
      index: 9999,
      outcome: "skipped",
      reason: "max-attempts",
    });
    expect(unattempted.doStreamCalls).toHaveLength(0);
  });

  it("reports post-output fallback skips as stream-mid", async () => {
    const phases: Array<string | undefined> = [];
    await runFallback(
      [
        errorPartModel(new Error("primary failed"), ["partial"]),
        textModel(["blocked"]),
      ],
      {
        acquireCandidate: () => undefined,
        onAttempt: ({ outcome, phase }) => {
          if (outcome === "skipped") {
            phases.push(phase);
          }
        },
        retryAfterOutput: true,
      }
    );

    expect(phases).toEqual(["stream-mid"]);
  });

  it("does not wait on a cooling final candidate", async () => {
    let waited = false;
    await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["cooling"])],
      {
        acquireCandidate: () => undefined,
        candidateAvailable: (candidate) => candidate.fullIndex !== 1,
        waitForCandidate: () => {
          waited = true;
          return Promise.resolve(1);
        },
      }
    );

    expect(waited).toBe(false);
  });

  it("releases a slot when health changes during admission", async () => {
    let available = true;
    const released: number[] = [];
    const releasedProbes: number[] = [];
    const secondary = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), secondary],
      {
        acquireCandidate: () => {
          available = false;
          return 1;
        },
        candidateAvailable: () => available,
        releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
      }
    );

    expect(out.error).toBeDefined();
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect(released).toContain(1);
    expect(releasedProbes).toContain(1);
  });

  it("releases acquired ownership when the post-admission health check throws", async () => {
    let availabilityReads = 0;
    const released: number[] = [];
    const releasedProbes: number[] = [];
    const secondary = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), secondary],
      {
        acquireCandidate: () => 1,
        candidateAvailable: () => {
          availabilityReads += 1;
          if (availabilityReads >= 3) {
            throw new Error("health recheck failed");
          }
          return true;
        },
        releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
      }
    );

    expect(out.error).toMatchObject({ message: "health recheck failed" });
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect(released).toContain(1);
    expect(releasedProbes).toContain(1);
  });

  it("releases a probe when health changes while waiting for capacity", async () => {
    let available = true;
    const released: number[] = [];
    const releasedProbes: number[] = [];
    const secondary = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), secondary],
      {
        acquireCandidate: () => undefined,
        candidateAvailable: () => available,
        releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
        waitForCandidate: () => {
          available = false;
          return Promise.resolve(1);
        },
      }
    );

    expect(out.error).toBeDefined();
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect(released).toContain(1);
    expect(releasedProbes).toContain(1);
  });

  it("claims a half-open probe only after capacity waiting succeeds", async () => {
    const order: string[] = [];
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["recovered"])],
      {
        acquireCandidate: () => undefined,
        prepareCandidate: () => {
          order.push("claim-probe");
          return true;
        },
        waitForCandidate: () => {
          order.push("wait-for-slot");
          return Promise.resolve(1);
        },
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(order).toEqual(["claim-probe", "wait-for-slot", "claim-probe"]);
  });

  it("releases waited ownership when probe preparation throws", async () => {
    let preparations = 0;
    const released: number[] = [];
    const releasedProbes: number[] = [];
    const secondary = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), secondary],
      {
        acquireCandidate: () => undefined,
        prepareCandidate: () => {
          preparations += 1;
          if (preparations === 2) {
            throw new Error("probe preparation failed");
          }
          return true;
        },
        releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
        waitForCandidate: () => Promise.resolve(1),
      }
    );

    expect(out.error).toMatchObject({ message: "probe preparation failed" });
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect(released).toContain(1);
    expect(releasedProbes).toContain(1);
  });

  it("hands off and releases a probe lease set before preparation throws", async () => {
    const released: Array<{ fullIndex: number; key?: string }> = [];
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["must not run"]),
      ],
      {
        acquireCandidate: () => 1,
        prepareCandidate: (candidate) => {
          candidate.probeLease = { key: "claimed", probingUntil: 123 };
          throw new Error("prepare failed after claim");
        },
        releaseProbeCandidate: (candidate) => {
          released.push({
            fullIndex: candidate.fullIndex,
            key: candidate.probeLease?.key,
          });
          candidate.probeLease = undefined;
        },
      }
    );

    expect(out.error).toMatchObject({
      message: "prepare failed after claim",
    });
    expect(released).toEqual([
      { fullIndex: 0, key: undefined },
      { fullIndex: 1, key: "claimed" },
    ]);
  });

  it.each([
    [
      "container",
      () => Promise.reject(new Error("async lease container")) as never,
    ],
    [
      "fields",
      () =>
        ({
          key: Promise.reject(new Error("async lease key")),
          probingUntil: Promise.reject(new Error("async lease deadline")),
        }) as never,
    ],
  ])("consumes rejected Promise-valued probe lease %s", async (_name, lease) => {
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["must not run"]),
      ],
      {
        acquireCandidate: () => 1,
        prepareCandidate: (candidate) => {
          candidate.probeLease = lease();
          return true;
        },
      }
    );

    expect(out.error).toMatchObject({
      message: "ai-router: stream candidate 1 probe lease is invalid",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("releases a partially prepared probe when preparation declines admission", async () => {
    const releasedProbes: number[] = [];
    const survivor = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: () => 1,
        prepareCandidate: (candidate) => {
          candidate.probeLease = { key: "partial", probingUntil: 123 };
          return false;
        },
        releaseProbeCandidate: (candidate) => {
          releasedProbes.push(candidate.fullIndex);
          candidate.probeLease = undefined;
        },
      }
    );

    expect(out.error).toMatchObject({ message: "primary failed" });
    expect(survivor.doStreamCalls).toHaveLength(0);
    expect(releasedProbes).toEqual([0, 1]);
  });

  it("isolates prepared candidate identity while handing off its probe lease", async () => {
    const acquired: number[] = [];
    const releasedProbes: Array<{ fullIndex: number; key?: string }> = [];
    const survivor = textModel(["ok"]);
    const replacement = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: ({ fullIndex }) => {
          acquired.push(fullIndex);
          return 1;
        },
        prepareCandidate: (candidate) => {
          candidate.fullIndex = 999;
          candidate.entry = replacement;
          Object.defineProperty(candidate, "model", {
            configurable: true,
            enumerable: true,
            value: replacement,
          });
          candidate.probeLease = { key: "prepared", probingUntil: 123 };
          return true;
        },
        releaseProbeCandidate: (candidate) => {
          releasedProbes.push({
            fullIndex: candidate.fullIndex,
            key: candidate.probeLease?.key,
          });
          candidate.probeLease = undefined;
        },
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("ok");
    expect(acquired).toEqual([1]);
    expect(releasedProbes).toEqual([
      { fullIndex: 0, key: undefined },
      { fullIndex: 1, key: "prepared" },
    ]);
    expect(replacement.doStreamCalls).toHaveLength(0);
  });

  it("releases waited capacity and a partially re-prepared declined probe", async () => {
    let preparations = 0;
    const releasedCapacity: number[] = [];
    const releasedProbes: Array<{
      fullIndex: number;
      source?: "local";
    }> = [];
    const survivor = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: () => undefined,
        prepareCandidate: (candidate) => {
          preparations += 1;
          candidate.probeLease = {
            key: "partial",
            probingUntil: 123,
            source: "local",
          };
          return preparations === 1;
        },
        releaseCandidate: ({ fullIndex }) => releasedCapacity.push(fullIndex),
        releaseProbeCandidate: (candidate) => {
          releasedProbes.push({
            fullIndex: candidate.fullIndex,
            source: candidate.probeLease?.source,
          });
          candidate.probeLease = undefined;
        },
        waitForCandidate: () => Promise.resolve(1),
      }
    );

    expect(out.error).toMatchObject({ message: "primary failed" });
    expect(survivor.doStreamCalls).toHaveLength(0);
    expect(releasedCapacity).toEqual([0, 1]);
    expect(releasedProbes).toEqual([
      { fullIndex: 0, source: undefined },
      { fullIndex: 1, source: "local" },
      { fullIndex: 1, source: "local" },
    ]);
  });

  it("isolates probe cleanup identity mutation before capacity waiting", async () => {
    const prepared: number[] = [];
    const waited: number[] = [];
    const released: number[] = [];
    const survivor = textModel(["ok"]);
    const replacement = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: () => undefined,
        prepareCandidate: (candidate) => {
          prepared.push(candidate.fullIndex);
          candidate.probeLease = { key: "probe", probingUntil: 123 };
          return true;
        },
        releaseProbeCandidate: (candidate) => {
          released.push(candidate.fullIndex);
          candidate.fullIndex = 999;
          candidate.entry = replacement;
          Object.defineProperty(candidate, "model", {
            configurable: true,
            enumerable: true,
            value: replacement,
          });
          candidate.probeLease = undefined;
        },
        waitForCandidate: (candidate) => {
          waited.push(candidate.fullIndex);
          return Promise.resolve(1);
        },
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("ok");
    expect(prepared).toEqual([1, 1]);
    expect(waited).toEqual([1]);
    expect(released).toEqual([0, 1, 1]);
    expect(replacement.doStreamCalls).toHaveLength(0);
  });

  it("releases a probe when capacity waiting rejects", async () => {
    const releasedProbes: number[] = [];
    const outcomes: [boolean, boolean, boolean][] = [];
    const attempts: Array<{
      attempt?: number;
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["blocked"])],
      {
        acquireCandidate: () => undefined,
        isBudgetFailure: () => true,
        onRequestOutcome: (success, eligible, suppressed) =>
          outcomes.push([success, eligible, suppressed]),
        onAttempt: ({ attempt, index, outcome, reason }) =>
          attempts.push({ attempt, index, outcome, reason }),
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
        waitForCandidate: () => Promise.reject(new Error("wait aborted")),
      }
    );

    expect(out.error).toMatchObject({ message: "wait aborted" });
    expect(releasedProbes).toEqual([0, 1]);
    expect(outcomes).toEqual([[false, true, true]]);
    expect(attempts).toEqual([
      {
        attempt: 1,
        index: 0,
        outcome: "failure",
        reason: undefined,
      },
    ]);
  });

  it("keeps earlier capacity skips when the final wait infrastructure rejects", async () => {
    const attempts: Array<{
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["earlier blocked"]),
        textModel(["wait failed"]),
      ],
      {
        acquireCandidate: () => undefined,
        onAttempt: ({ index, outcome, reason }) =>
          attempts.push({ index, outcome, reason }),
        waitForCandidate: () =>
          Promise.reject(new Error("wait infrastructure failed")),
      }
    );

    expect(out.error).toMatchObject({ message: "wait infrastructure failed" });
    expect(attempts).toEqual([
      { index: 0, outcome: "failure", reason: undefined },
      { index: 1, outcome: "skipped", reason: "concurrency" },
    ]);
  });

  it("does not execute arbitrary admission wait thenable extensions", async () => {
    let thenReads = 0;
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["blocked"])],
      {
        acquireCandidate: () => undefined,
        waitForCandidate: () =>
          Object.defineProperty({}, ["th", "en"].join(""), {
            get() {
              thenReads += 1;
              throw new Error("then extension must not run");
            },
          }) as never,
      }
    );

    expect(out.error).toMatchObject({
      message: "ai-router: admission wait hook must return a genuine Promise",
    });
    expect(thenReads).toBe(0);
  });

  it("rejects malformed admission wait in-flight counts", async () => {
    const survivor = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: () => undefined,
        waitForCandidate: () => Promise.resolve(0),
      }
    );

    expect(out.error).toMatchObject({
      message:
        "ai-router: admission wait hook must resolve to a positive safe in-flight count or undefined",
    });
    expect(survivor.doStreamCalls).toHaveLength(0);
  });

  it("rejects malformed immediate admission in-flight counts", async () => {
    const survivor = textModel(["must not run"]);
    const releasedProbes: number[] = [];
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: () => Number.POSITIVE_INFINITY,
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
      }
    );

    expect(out.error).toMatchObject({
      message:
        "ai-router: admission acquire hook must return a positive safe in-flight count or undefined",
    });
    expect(survivor.doStreamCalls).toHaveLength(0);
    expect(releasedProbes).toEqual([0, 1]);
  });

  it("releases a prepared probe when admission acquire throws", async () => {
    const releasedProbes: number[] = [];
    const survivor = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: () => {
          throw new Error("acquire failed");
        },
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
      }
    );

    expect(out.error).toMatchObject({ message: "acquire failed" });
    expect(survivor.doStreamCalls).toHaveLength(0);
    expect(releasedProbes).toEqual([0, 1]);
  });

  it("captures admission hook accessors once with their receiver", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["ok"]);
    const candidates = [resolved(primary, 0), resolved(survivor, 1)];
    const originalProbeLease = {
      key: "stable",
      probingUntil: 1234,
      source: "local" as const,
    };
    candidates[1].probeLease = originalProbeLease;
    const firstResult = await primary.doStream(callOptions);
    const reads = {
      acquire: 0,
      available: 0,
      firstResult: 0,
      maxAttempts: 0,
      success: 0,
    };
    let priorErrorIteratorReads = 0;
    let priorErrorIndexReads = 0;
    const priorErrors = [new Error("earlier open failed")];
    Object.defineProperties(priorErrors, {
      0: {
        configurable: true,
        get() {
          priorErrorIndexReads += 1;
          throw new Error("prior error index must not run");
        },
      },
      [Symbol.iterator]: {
        get() {
          priorErrorIteratorReads += 1;
          throw new Error("prior error iterator must not run");
        },
      },
    });
    const args: FallbackStreamArgs = {
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      priorErrors,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };
    Object.defineProperties(args, {
      acquireCandidate: {
        configurable: true,
        get() {
          reads.acquire += 1;
          return function (this: unknown) {
            expect(this).toBe(args);
            return 1;
          };
        },
      },
      candidateAvailable: {
        configurable: true,
        get() {
          reads.available += 1;
          return function (this: unknown) {
            expect(this).toBe(args);
            return true;
          };
        },
      },
      firstResult: {
        configurable: true,
        get() {
          reads.firstResult += 1;
          return firstResult;
        },
      },
      maxAttempts: {
        configurable: true,
        get() {
          reads.maxAttempts += 1;
          return 2;
        },
      },
      onCandidateSuccess: {
        configurable: true,
        get() {
          reads.success += 1;
          return function (this: unknown, candidate: ResolvedEntry) {
            expect(this).toBe(args);
            expect(candidate.probeLease).toEqual({
              key: "stable",
              probingUntil: 1234,
              source: "local",
            });
            return;
          };
        },
      },
    });

    const wrapped = wrapStreamResult(args);
    const mutated = textModel(["mutated candidate must not run"]);
    const fallbackCandidate = candidates[1];
    candidates[1] = resolved(mutated, 1);
    fallbackCandidate.entry = mutated;
    fallbackCandidate.fullIndex = 999;
    fallbackCandidate.model = mutated;
    originalProbeLease.key = "mutated";
    originalProbeLease.probingUntil = 9999;
    Object.defineProperties(args, {
      acquireCandidate: {
        value: () => {
          throw new Error("mutated acquire hook must not run");
        },
      },
      candidateAvailable: {
        value: () => {
          throw new Error("mutated availability hook must not run");
        },
      },
      firstResult: {
        value: {
          stream: new ReadableStream<LanguageModelV4StreamPart>(),
        },
      },
      maxAttempts: { value: 1 },
      onCandidateSuccess: {
        value: () => {
          throw new Error("mutated success hook must not run");
        },
      },
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(mutated.doStreamCalls).toHaveLength(0);
    expect(priorErrorIndexReads).toBe(0);
    expect(priorErrorIteratorReads).toBe(0);
    expect(reads).toEqual({
      acquire: 1,
      available: 1,
      firstResult: 1,
      maxAttempts: 1,
      success: 1,
    });
  });

  it("snapshots call options before opening a fallback provider", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    let fallbackPrompt: unknown;
    const survivor = new MockLanguageModelV4({
      doStream: (options) => {
        fallbackPrompt = options.prompt;
        return textModel(["ok"]).doStream(options);
      },
    });
    const candidates = [resolved(primary, 0), resolved(survivor, 1)];
    const options = {
      ...callOptions,
      prompt: [
        {
          content: [{ text: "stable", type: "text" as const }],
          role: "user" as const,
        },
      ],
    } as LanguageModelV4CallOptions;
    const firstResult = await primary.doStream(options);
    const requestBody = { prompt: "stable request metadata" };
    firstResult.request = { body: requestBody };
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });
    const firstPrompt = options.prompt[0] as {
      content: Array<{ text: string }>;
    };
    firstPrompt.content[0].text = "mutated";
    requestBody.prompt = "mutated request metadata";
    expect(wrapped.request).toEqual({
      body: { prompt: "stable request metadata" },
    });
    const exposedRequest = wrapped.request as {
      body: { prompt: string };
    };
    exposedRequest.body.prompt = "consumer mutation";
    expect(wrapped.request).toEqual({
      body: { prompt: "stable request metadata" },
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(fallbackPrompt).toEqual([
      {
        content: [{ text: "stable", type: "text" }],
        role: "user",
      },
    ]);
  });

  it("cleans initial ownership and consumes Promise siblings when hook capture fails", async () => {
    let upstreamCancelled = 0;
    const releases: string[] = [];
    const model = textModel(["must not run"]);
    const candidate = resolved(model, 0);
    const firstResult = {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        cancel() {
          upstreamCancelled += 1;
        },
      }),
    };
    const args: FallbackStreamArgs = {
      candidates: [candidate],
      firstResult,
      logicalId: "chat",
      onError: Promise.reject(new Error("async hook sibling")) as never,
      options: callOptions,
      releaseCandidate: () => releases.push("capacity"),
      releaseProbeCandidate: () => releases.push("probe"),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };
    Object.defineProperty(args, "acquireCandidate", {
      get() {
        throw new Error("acquire hook unavailable");
      },
    });

    expect(() => wrapStreamResult(args)).toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ message: "acquire hook unavailable" }),
        code: "stream_unavailable",
      })
    );
    expect(upstreamCancelled).toBe(1);
    expect(releases).toEqual(["capacity", "probe"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("isolates capacity cleanup mutation from canonical probe cleanup", async () => {
    const model = textModel(["ok"]);
    const candidate = resolved(model, 1);
    const lease = { key: "lease", probingUntil: 123 };
    candidate.probeLease = lease;
    const releasedCapacity: number[] = [];
    const releasedProbe: Array<{ fullIndex: number; lease: unknown }> = [];
    let canonicalProbeCandidate: ResolvedEntry | undefined;
    const firstResult = await model.doStream(callOptions);

    const wrapped = wrapStreamResult({
      candidates: [candidate],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      releaseCandidate: (entry) => {
        releasedCapacity.push(entry.fullIndex);
        entry.fullIndex = 999;
        entry.probeLease = undefined;
      },
      releaseProbeCandidate: (entry) => {
        canonicalProbeCandidate = entry;
        releasedProbe.push({
          fullIndex: entry.fullIndex,
          lease: entry.probeLease,
        });
        entry.probeLease = undefined;
      },
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(releasedCapacity).toEqual([1]);
    expect(releasedProbe).toEqual([{ fullIndex: 1, lease }]);
    expect(candidate.fullIndex).toBe(1);
    expect(candidate.probeLease).toBe(lease);
    expect(canonicalProbeCandidate?.probeLease).toBeUndefined();
  });

  it("consumes rejected Promise mutations on discarded cleanup snapshots", async () => {
    const mutateWithRejectedPromises = (candidate: ResolvedEntry) => {
      candidate.entry = Promise.reject(new Error("async entry")) as never;
      candidate.fullIndex = Promise.reject(
        new Error("async full index")
      ) as never;
      Object.defineProperty(candidate, "model", {
        configurable: true,
        enumerable: true,
        value: Promise.reject(new Error("async model")),
      });
      candidate.probeLease = {
        key: Promise.reject(new Error("async probe key")),
        probingUntil: Promise.reject(new Error("async probe deadline")),
      } as never;
    };
    const out = await runFallback([textModel(["ok"])], {
      releaseCandidate: mutateWithRejectedPromises,
      releaseProbeCandidate: mutateWithRejectedPromises,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected identity mutations on a discarded preparation snapshot", async () => {
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["must not run"]),
      ],
      {
        acquireCandidate: () => 1,
        prepareCandidate: (candidate) => {
          candidate.entry = Promise.reject(
            new Error("async prepared entry")
          ) as never;
          candidate.fullIndex = Promise.reject(
            new Error("async prepared index")
          ) as never;
          Object.defineProperty(candidate, "model", {
            configurable: true,
            enumerable: true,
            value: Promise.reject(new Error("async prepared model")),
          });
          return false;
        },
      }
    );

    expect(out.error).toMatchObject({ message: "primary failed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected mutations on discarded read-only hook snapshots", async () => {
    const mutate = (candidate: ResolvedEntry, label: string) => {
      candidate.entry = Promise.reject(new Error(`${label} entry`)) as never;
      candidate.fullIndex = Promise.reject(
        new Error(`${label} index`)
      ) as never;
      Object.defineProperty(candidate, "model", {
        configurable: true,
        enumerable: true,
        value: Promise.reject(new Error(`${label} model`)),
      });
      candidate.probeLease = Promise.reject(
        new Error(`${label} lease`)
      ) as never;
    };
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["ok"])],
      {
        acquireCandidate: (candidate) => {
          mutate(candidate, "acquire");
          return 1;
        },
        candidateAvailable: (candidate) => {
          mutate(candidate, "available");
          return true;
        },
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected mutations on a discarded capacity-wait snapshot", async () => {
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["ok"])],
      {
        acquireCandidate: () => undefined,
        waitForCandidate: (candidate) => {
          candidate.entry = Promise.reject(new Error("wait entry")) as never;
          candidate.probeLease = Promise.reject(
            new Error("wait lease")
          ) as never;
          return Promise.resolve(1);
        },
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("pre-consumes direct createFallbackStream argument siblings before firstResult access", async () => {
    let firstResultReads = 0;
    const args = Object.defineProperties(
      {
        onError: Promise.reject(new Error("async direct sibling")),
      },
      {
        firstResult: {
          get() {
            firstResultReads += 1;
            throw new Error("first result unavailable");
          },
        },
      }
    ) as unknown as FallbackStreamArgs;

    expect(() => createFallbackStream(args, () => undefined)).toThrowError(
      "first result unavailable"
    );
    expect(firstResultReads).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects candidate array accessors without executing them", () => {
    let reads = 0;
    let upstreamCancelled = 0;
    const candidate = resolved(textModel(["must not run"]), 0);
    const candidates = [candidate];
    Object.defineProperty(candidates, 0, {
      configurable: true,
      get() {
        reads += 1;
        throw new Error("candidate accessor must not run");
      },
    });
    const args: FallbackStreamArgs = {
      candidates,
      firstResult: {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            upstreamCancelled += 1;
          },
        }),
      },
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };

    expect(() => wrapStreamResult(args)).toThrow(
      expect.objectContaining({ code: "stream_unavailable" })
    );
    expect(reads).toBe(0);
    expect(upstreamCancelled).toBe(1);
  });

  it("rejects ResolvedEntry field accessors without executing them", () => {
    let reads = 0;
    let upstreamCancelled = 0;
    const model = textModel(["must not run"]);
    const candidate = Object.defineProperty(
      { entry: model, model },
      "fullIndex",
      {
        get() {
          reads += 1;
          return 0;
        },
      }
    ) as unknown as ResolvedEntry;
    const args: FallbackStreamArgs = {
      candidates: [candidate],
      firstResult: {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            upstreamCancelled += 1;
          },
        }),
      },
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };

    expect(() => wrapStreamResult(args)).toThrow(
      expect.objectContaining({ code: "stream_unavailable" })
    );
    expect(reads).toBe(0);
    expect(upstreamCancelled).toBe(1);
  });

  it("consumes an async lazy candidate model and continues fallback", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["survived"]);
    const asyncCandidate = {
      entry: survivor,
      fullIndex: 1,
      get model() {
        return Promise.reject(new Error("async model unsupported"));
      },
    } as unknown as ResolvedEntry;
    const candidates = [
      resolved(primary, 0),
      asyncCandidate,
      resolved(survivor, 2),
    ];
    const firstResult = await primary.doStream(callOptions);
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({
      text: "survived",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("preserves stream setup errors across hostile cleanup accessors", () => {
    const OriginalReadableStream = globalThis.ReadableStream;
    let upstreamCancelled = 0;
    let probeReleased = 0;
    const model = textModel(["must not run"]);
    const args: FallbackStreamArgs = {
      candidates: [resolved(model, 0)],
      firstResult: {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            upstreamCancelled += 1;
          },
        }),
      },
      logicalId: "chat",
      options: callOptions,
      releaseProbeCandidate: () => {
        probeReleased += 1;
      },
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };
    Object.defineProperty(args, "releaseCandidate", {
      get() {
        throw new Error("capacity cleanup accessor failed");
      },
    });
    vi.stubGlobal(
      "ReadableStream",
      class {
        constructor() {
          throw new Error("ReadableStream unavailable");
        }
      }
    );
    try {
      expect(() => wrapStreamResult(args)).toThrow(
        expect.objectContaining({
          cause: expect.objectContaining({
            message: "ReadableStream unavailable",
          }),
          code: "stream_unavailable",
        })
      );
      expect(upstreamCancelled).toBe(1);
      expect(probeReleased).toBe(1);
    } finally {
      vi.stubGlobal("ReadableStream", OriginalReadableStream);
    }
  });

  it("does not re-read candidate accessors during wrapper construction cleanup", () => {
    const OriginalReadableStream = globalThis.ReadableStream;
    let reads = 0;
    let upstreamCancelled = 0;
    const releases: string[] = [];
    const candidate = resolved(textModel(["must not run"]), 0);
    const candidates = [candidate];
    Object.defineProperty(candidates, 0, {
      configurable: true,
      get() {
        reads += 1;
        throw new Error("candidate accessor must not run");
      },
    });
    const args: FallbackStreamArgs = {
      candidates,
      firstResult: {
        stream: new OriginalReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            upstreamCancelled += 1;
          },
        }),
      },
      logicalId: "chat",
      options: callOptions,
      releaseCandidate: () => releases.push("capacity"),
      releaseProbeCandidate: () => releases.push("probe"),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };
    vi.stubGlobal(
      "ReadableStream",
      class {
        constructor() {
          throw new Error("ReadableStream unavailable");
        }
      }
    );
    try {
      expect(() => wrapStreamResult(args)).toThrow(
        expect.objectContaining({ code: "stream_unavailable" })
      );
      expect(reads).toBe(0);
      expect(upstreamCancelled).toBe(1);
      expect(releases).toEqual(["capacity", "probe"]);
    } finally {
      vi.stubGlobal("ReadableStream", OriginalReadableStream);
    }
  });

  it.each([
    ["attemptsStarted", 0],
    ["attemptTimeout", Number.NaN],
    ["backoff", 0],
    ["budgetFailureObserved", "yes"],
    ["firstContentTimeout", 86_400_001],
    ["logicalId", ""],
    ["maxAttempts", 1.5],
    ["options", null],
    ["retryAfterOutput", "yes"],
    ["startIndex", 1],
    ["startInFlight", 0],
    ["strictStreamValidation", "yes"],
    ["totalDeadline", Number.POSITIVE_INFINITY],
    ["totalTimeout", -1],
  ])("rejects malformed stream setup scalar %s", (key, value) => {
    let upstreamCancelled = 0;
    const releases: string[] = [];
    const model = textModel(["must not run"]);
    const args: FallbackStreamArgs = {
      candidates: [resolved(model, 0)],
      firstResult: {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            upstreamCancelled += 1;
          },
        }),
      },
      logicalId: "chat",
      options: callOptions,
      releaseCandidate: () => releases.push("capacity"),
      releaseProbeCandidate: () => releases.push("probe"),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };
    Reflect.set(args, key, value);

    expect(() => wrapStreamResult(args)).toThrow(
      expect.objectContaining({ code: "stream_unavailable" })
    );
    expect(upstreamCancelled).toBe(1);
    expect(releases).toEqual(["capacity", "probe"]);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("falls back on a PRE-output in-band error part, swallowing the error", async () => {
    const primary = errorPartModel(new Error("overloaded 503"));
    const secondary = textModel(["from ", "secondary"]);
    const seen: Array<{ index: number; phase?: string; willRetry?: boolean }> =
      [];

    const out = await runFallback([primary, secondary], {
      onError: (info) =>
        seen.push({
          index: info.index,
          phase: info.phase,
          willRetry: info.willRetry,
        }),
    });

    expect(out.text).toBe("from secondary");
    // The failed candidate's terminal error part was swallowed, not forwarded.
    expect(out.parts.some((p) => p.type === "error")).toBe(false);
    expect(out.error).toBeUndefined();
    expect(seen).toEqual([{ index: 0, phase: "stream-open", willRetry: true }]);
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(secondary.doStreamCalls).toHaveLength(1);
  });

  it("does NOT fall back after content streamed (retryAfterOutput=false) — no double-emit", async () => {
    const primary = errorPartModel(new Error("503"), ["partial answer"]);
    const secondary = textModel(["SHOULD NOT APPEAR"]);

    const out = await runFallback([primary, secondary], {
      retryAfterOutput: false,
    });

    // 'partial answer' appears exactly once; the secondary is never consulted.
    expect(out.text).toBe("partial answer");
    expect(secondary.doStreamCalls).toHaveLength(0);
    // The terminal error part is forwarded verbatim (cannot un-ring the bell).
    expect(out.parts.some((p) => p.type === "error")).toBe(true);
  });

  it("DOES fall back after content when retryAfterOutput=true (may duplicate)", async () => {
    const primary = errorPartModel(new Error("503"), ["partial "]);
    const secondary = textModel(["secondary"]);

    const out = await runFallback([primary, secondary], {
      retryAfterOutput: true,
    });

    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(out.text).toContain("partial ");
    expect(out.text).toContain("secondary");
  });

  it("restarts first-content validation for each post-output fallback", async () => {
    const hangingAfterFraming = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "middle" });
            },
          }),
        }),
    });
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed"), ["partial "]),
        hangingAfterFraming,
        textModel(["recovered"]),
      ],
      { firstContentTimeout: 10, retryAfterOutput: true }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("partial recovered");
    expect(
      out.parts.filter((part) => part.type === "stream-start")
    ).toHaveLength(2);
  });

  it("cancels a timed-out pending read and releases its reader lock once", async () => {
    let cancelCalls = 0;
    let releaseCalls = 0;
    const reader = {
      cancel() {
        cancelCalls += 1;
        return Promise.resolve();
      },
      read: () => new Promise<never>(() => undefined),
      releaseLock() {
        releaseCalls += 1;
      },
    };
    const hanging = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: { getReader: () => reader },
        }) as never,
    });

    const out = await runFallback([hanging, textModel(["recovered"])], {
      firstContentTimeout: 10,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(cancelCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it("treats a rejected read (transport drop) like an error and falls back", async () => {
    const primary = transportRejectModel(new Error("transport drop 503"));
    const secondary = textModel(["recovered"]);

    const out = await runFallback([primary, secondary]);
    expect(out.text).toBe("recovered");
    expect(out.error).toBeUndefined();
  });

  it("rejects malformed finish metadata using post-output retry policy", async () => {
    const malformed = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "partial" },
      { type: "text-end", id: "1" },
      {
        type: "finish",
        finishReason,
        usage: {
          ...usage,
          outputTokens: { ...usage.outputTokens, total: Number.NaN },
        },
      },
    ]);
    const stopped = await runFallback([malformed, textModel(["unused"])]);
    expect(stopped.error).toMatchObject({ code: "invalid_model_stream" });

    const retried = await runFallback([malformed, textModel(["recovered"])], {
      retryAfterOutput: true,
    });
    expect(retried.error).toBeUndefined();
    expect(retried.text).toBe("partialrecovered");
  });

  it("falls back when finish metadata getters throw", async () => {
    const hostileFinish = Object.defineProperty(
      { type: "finish", usage },
      "finishReason",
      {
        get() {
          throw new Error("finish getter failed");
        },
      }
    ) as LanguageModelV4StreamPart;
    const malformed = chunkModel([
      { type: "stream-start", warnings: [] },
      hostileFinish,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
  });

  it("consumes rejected async siblings across a malformed finish part", async () => {
    const rejected = (label: string) => Promise.reject(new Error(label));
    const malformed = lazyChunkModel([
      () => ({ type: "stream-start", warnings: [] }),
      () =>
        ({
          finishReason: {
            raw: rejected("async raw finish reason"),
            unified: rejected("async unified finish reason"),
          },
          providerMetadata: rejected("async finish provider metadata"),
          type: "finish",
          usage: {
            inputTokens: {
              cacheRead: rejected("async cache read"),
              cacheWrite: rejected("async cache write"),
              noCache: 10,
              total: 10,
            },
            outputTokens: {
              reasoning: rejected("async reasoning tokens"),
              text: rejected("async text tokens"),
              total: 20,
            },
            raw: {
              first: rejected("async raw usage first"),
              second: rejected("async raw usage second"),
            },
          },
        }) as never,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("falls back on malformed stream warnings", async () => {
    for (const warnings of [
      [{ type: "other" }],
      [{ message: "x".repeat(65_537), type: "other" }],
      Array.from({ length: 17 }, () => ({
        message: "x".repeat(65_536),
        type: "other" as const,
      })),
      new Array(1),
      new Array(1_000_000),
    ]) {
      const malformed = chunkModel([
        { type: "stream-start", warnings } as never,
      ]);

      const out = await runFallback([malformed, textModel(["recovered"])]);
      expect(out.error).toBeUndefined();
      expect(out.text).toBe("recovered");
    }
  });

  it("consumes every rejected async stream warning sibling", async () => {
    const malformed = lazyChunkModel([
      () =>
        ({
          type: "stream-start",
          warnings: [
            {
              details: Promise.reject(new Error("async warning details")),
              feature: Promise.reject(new Error("async warning feature")),
              type: "unsupported",
            },
            Promise.reject(new Error("async warning entry")),
          ],
        }) as never,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("falls back on malformed known stream part fields", async () => {
    const malformedStreams = [
      chunkModel([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: 42 } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "" },
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "x".repeat(4097) },
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        { type: "" } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        { type: "x".repeat(257) } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        { type: 42 } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        {
          data: {},
          mediaType: "image/png",
          type: "file",
        } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        { kind: "invalid", type: "custom" } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        {
          id: "tool",
          providerExecuted: "yes",
          toolName: "tool",
          type: "tool-input-start",
        } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        {
          id: "source",
          providerMetadata: "invalid",
          sourceType: "url",
          title: 42,
          type: "source",
          url: "https://example.com",
        } as never,
      ]),
    ];

    for (const malformed of malformedStreams) {
      const out = await runFallback([malformed, textModel(["recovered"])]);
      expect(out.error).toBeUndefined();
      expect(out.text).toBe("recovered");
    }
  });

  it("does not read fields from the inactive stream source variant", async () => {
    let inactiveReads = 0;
    const source = Object.defineProperties(
      {
        id: "source",
        sourceType: "url",
        title: "Example",
        type: "source",
        url: "https://example.com/source",
      },
      {
        filename: {
          get() {
            inactiveReads += 1;
            throw new Error("inactive filename must not be read");
          },
        },
        mediaType: {
          get() {
            inactiveReads += 1;
            throw new Error("inactive media type must not be read");
          },
        },
      }
    ) as LanguageModelV4StreamPart;
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      source,
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);

    expect(out.error).toBeUndefined();
    expect(out.parts).toContainEqual(source);
    expect(inactiveReads).toBe(0);
  });

  it("consumes source Promise siblings before ordinary discriminant getters fail", async () => {
    const rejectedHandled = (message: string) => {
      const promise = Promise.reject(new Error(message));
      promise.catch(() => undefined);
      return promise;
    };
    const source = Object.defineProperties(
      { type: "source" },
      {
        filename: {
          value: rejectedHandled("async filename sibling"),
        },
        sourceType: {
          get() {
            throw new Error("source discriminant failed");
          },
        },
        url: {
          value: rejectedHandled("async URL sibling"),
        },
      }
    ) as never;
    const malformed = chunkModel([
      { type: "stream-start", warnings: [] },
      source,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes active stream-field Promise siblings before a getter fails", async () => {
    const metadata = Promise.reject(new Error("async source metadata sibling"));
    metadata.catch(() => undefined);
    const source = Object.defineProperties(
      { sourceType: "url", type: "source" },
      {
        id: {
          get() {
            throw new Error("source id failed");
          },
        },
        providerMetadata: {
          value: metadata,
        },
        url: { value: "https://example.test/source" },
      }
    ) as never;
    const malformed = chunkModel([
      { type: "stream-start", warnings: [] },
      source,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects non-string stream discriminants without coercion", async () => {
    let coercions = 0;
    const hostile = {
      toString() {
        coercions += 1;
        return "text-delta";
      },
    };
    for (const malformed of [
      chunkModel([
        { type: "stream-start", warnings: [] },
        { delta: "bad", id: "1", type: hostile } as never,
      ]),
      chunkModel([
        {
          type: "stream-start",
          warnings: [{ message: "bad", type: hostile }],
        } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        {
          finishReason: { raw: "stop", unified: hostile },
          type: "finish",
          usage,
        } as never,
      ]),
    ]) {
      const out = await runFallback([malformed, textModel(["recovered"])]);
      expect(out.error).toBeUndefined();
      expect(out.text).toBe("recovered");
    }
    expect(coercions).toBe(0);
  });

  it("rejects unknown stream file tags without reading payload fields", async () => {
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
    const malformed = chunkModel([
      { type: "stream-start", warnings: [] },
      { data, mediaType: "image/png", type: "file" } as never,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(reads).toBe(0);
  });

  it("consumes rejected nested streamed file payloads before fallback", async () => {
    const malformed = lazyChunkModel([
      () => ({ type: "stream-start", warnings: [] }),
      () =>
        ({
          data: {
            data: Promise.reject(new Error("async streamed file data")),
            type: "data",
          },
          mediaType: "image/png",
          type: "file",
        }) as never,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes own Promise siblings after an async stream discriminant", async () => {
    const malformed = lazyChunkModel([
      () => ({ type: "stream-start", warnings: [] }),
      () =>
        ({
          data: Promise.reject(new Error("async stream data sibling")),
          mediaType: Promise.reject(
            new Error("async stream media type sibling")
          ),
          providerMetadata: Promise.reject(
            new Error("async stream metadata sibling")
          ),
          type: Promise.reject(new Error("async stream discriminant")),
        }) as never,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots mutable streamed byte and URL payloads", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const url = new URL("https://example.com/file.png");
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      {
        data: { data: bytes, type: "data" },
        mediaType: "image/png",
        type: "file",
      } as never,
      {
        data: { type: "url", url },
        mediaType: "image/png",
        type: "file",
      } as never,
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);
    const files = out.parts.filter(
      (part) => part.type === "file"
    ) as unknown as Array<{
      data: { data?: Uint8Array; url?: URL };
    }>;
    bytes[0] = 9;
    url.pathname = "/mutated.png";

    expect(out.error).toBeUndefined();
    expect(files[0].data.data).not.toBe(bytes);
    expect([...(files[0].data.data ?? [])]).toEqual([1, 2, 3]);
    expect(files[1].data.url).not.toBe(url);
    expect(files[1].data.url?.toString()).toBe("https://example.com/file.png");
  });

  it("falls back when stream-part provider metadata access throws", async () => {
    const hostileDelta = Object.defineProperty(
      { delta: "unusable", id: "1", type: "text-delta" },
      "providerMetadata",
      {
        get() {
          throw new Error("stream metadata getter failed");
        },
      }
    ) as LanguageModelV4StreamPart;
    const malformed = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      hostileDelta,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
  });

  it("falls back on cyclic stream provider JSON payloads", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const malformedParts = [
      {
        id: "1",
        providerMetadata: { mock: circular },
        type: "text-start",
      },
      {
        result: circular,
        toolCallId: "call",
        toolName: "tool",
        type: "tool-result",
      },
    ];

    for (const part of malformedParts) {
      const malformed = chunkModel([
        { type: "stream-start", warnings: [] },
        part as LanguageModelV4StreamPart,
      ]);
      const out = await runFallback([malformed, textModel(["recovered"])]);

      expect(out.error).toBeUndefined();
      expect(out.text).toBe("recovered");
    }
  });

  it("falls back on malformed response metadata fields", async () => {
    const malformedParts = [
      { id: 42, type: "response-metadata" },
      { modelId: false, type: "response-metadata" },
      { timestamp: new Date(Number.NaN), type: "response-metadata" },
      Object.defineProperty({ type: "response-metadata" }, "timestamp", {
        get() {
          throw new Error("timestamp getter failed");
        },
      }),
    ];

    for (const part of malformedParts) {
      const malformed = chunkModel([
        { type: "stream-start", warnings: [] },
        part as LanguageModelV4StreamPart,
      ]);
      const out = await runFallback([malformed, textModel(["recovered"])]);
      expect(out.error).toBeUndefined();
      expect(out.text).toBe("recovered");
    }
  });

  it("bounds oversized stream warning collections", async () => {
    const malformed = chunkModel([
      {
        type: "stream-start",
        warnings: Array.from({ length: 1025 }, () => ({
          message: "warning",
          type: "other" as const,
        })),
      },
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
  });

  it("does NOT fall back on a non-retryable pre-output error", async () => {
    const primary = errorPartModel({
      statusCode: 404,
      message: "unrelated resource not found",
    });
    const secondary = textModel(["secondary"]);

    const out = await runFallback([primary, secondary]);
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect((out.error as { statusCode?: number }).statusCode).toBe(404);
  });

  it("surfaces an AggregateError when every candidate fails mid-stream", async () => {
    const a = errorPartModel(new Error("first 503"));
    const b = errorPartModel(new Error("second 503"));
    const c = errorPartModel(new Error("last 503"));

    const out = await runFallback([a, b, c]);
    expect(out.error).toBeInstanceOf(AggregateError);
    expect((out.error as AggregateError).errors).toHaveLength(3);
    expect((out.error as AggregateError).message).toContain("last 503");
    expect((out.error as AggregateError).cause).toBe(
      (out.error as AggregateError).errors.at(-1)
    );
  });

  it("keeps stream aggregate summaries stable across error hook mutation", async () => {
    const first = new Error("first stream original");
    const last = new Error("last stream original");
    const out = await runFallback(
      [errorPartModel(first), errorPartModel(last)],
      {
        onError: ({ error }) => {
          if (error instanceof Error) {
            error.message = "mutated by stream hook";
          }
        },
      }
    );

    expect(out.error).toBeInstanceOf(AggregateError);
    expect((out.error as AggregateError).message).toContain(
      "last stream original"
    );
    expect((out.error as AggregateError).message).not.toContain(
      "mutated by stream hook"
    );
    expect((out.error as AggregateError).cause).toBe(last);
  });

  it("surfaces an AggregateError including prior retryable errors when a later candidate fails non-retryably", async () => {
    // A and B fail with retryable 503s (each triggers fallback and accumulates),
    // then C emits a non-retryable 400. The consumer must see all three errors,
    // not just C's 400 — matching the README's all-candidates-failed contract.
    const a = errorPartModel(new Error("first 503"));
    const b = errorPartModel(new Error("second 503"));
    const c = errorPartModel({ statusCode: 400, message: "bad request" });

    const out = await runFallback([a, b, c]);
    expect(out.error).toBeInstanceOf(AggregateError);
    expect((out.error as AggregateError).errors).toHaveLength(3);
    expect(a.doStreamCalls).toHaveLength(1);
    expect(b.doStreamCalls).toHaveLength(1);
    expect(c.doStreamCalls).toHaveLength(1);
  });

  it("falls back on a pre-content error that arrives AFTER framing parts (response-metadata/text-start)", async () => {
    // The openai-compatible provider emits response-metadata (and text-start) on
    // its first chunk before any text-delta. An error there is still pre-content.
    const primary = chunkModel([
      { type: "stream-start", warnings: [] },
      {
        type: "response-metadata",
        id: "res-1",
        modelId: "m",
        timestamp: new Date(0),
      },
      { type: "text-start", id: "1" },
      { type: "error", error: new Error("overloaded 503") },
    ]);
    const secondary = textModel(["from secondary"]);

    const out = await runFallback([primary, secondary]);
    expect(out.text).toBe("from secondary");
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(out.parts.some((p) => p.type === "error")).toBe(false);
  });

  it("emits exactly one stream-start after a pre-content fallback", async () => {
    const out = await runFallback([
      errorPartModel(new Error("503")),
      textModel(["ok"]),
    ]);
    expect(out.parts.filter((p) => p.type === "stream-start")).toHaveLength(1);
  });

  it("does not leak the failed candidate framing parts (no duplicate response-metadata/text-start)", async () => {
    // Primary forwards a full framing prelude then fails pre-content; none of it
    // must reach the consumer — only the survivor's single clean lifecycle.
    const primary = chunkModel([
      { type: "stream-start", warnings: [] },
      {
        type: "response-metadata",
        id: "res-1",
        modelId: "m",
        timestamp: new Date(0),
      },
      { type: "text-start", id: "1" },
      { type: "error", error: new Error("overloaded 503") },
    ]);
    const secondary = chunkModel([
      { type: "stream-start", warnings: [] },
      {
        type: "response-metadata",
        id: "res-2",
        modelId: "m",
        timestamp: new Date(0),
      },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "ok" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([primary, secondary]);
    expect(out.text).toBe("ok");
    expect(out.parts.filter((p) => p.type === "stream-start")).toHaveLength(1);
    expect(
      out.parts.filter((p) => p.type === "response-metadata")
    ).toHaveLength(1);
    expect(out.parts.filter((p) => p.type === "text-start")).toHaveLength(1);
  });

  it("forwards only the survivor's warnings and raw prelude", async () => {
    const failed = chunkModel([
      {
        type: "stream-start",
        warnings: [{ type: "other", message: "failed warning" }],
      },
      { type: "raw", rawValue: "failed raw" },
      { type: "error", error: new Error("failed") },
    ]);
    const survivor = chunkModel([
      {
        type: "stream-start",
        warnings: [{ type: "other", message: "survivor warning" }],
      },
      { type: "raw", rawValue: "survivor raw" },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "ok" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([failed, survivor]);
    const starts = out.parts.filter((part) => part.type === "stream-start");
    const raws = out.parts.filter((part) => part.type === "raw");
    expect(starts).toEqual([
      {
        type: "stream-start",
        warnings: [{ type: "other", message: "survivor warning" }],
      },
    ]);
    expect(raws).toEqual([{ type: "raw", rawValue: "survivor raw" }]);
  });

  it("snapshots ordinary raw JSON and recognized mutable raw values", async () => {
    const rawJson = { nested: { value: "before" } };
    const opaque = new Uint8Array([1, 2, 3]);
    const rawUrl = new URL("https://example.com/raw");
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "raw", rawValue: rawJson },
      { type: "raw", rawValue: opaque },
      { type: "raw", rawValue: rawUrl },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "ok" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);
    rawJson.nested.value = "after";
    opaque[0] = 9;
    rawUrl.pathname = "/mutated";
    const raws = out.parts.filter((part) => part.type === "raw");

    expect(raws[0]).toEqual({
      type: "raw",
      rawValue: { nested: { value: "before" } },
    });
    expect(raws[0]?.rawValue).not.toBe(rawJson);
    expect(raws[1]?.rawValue).not.toBe(opaque);
    expect([...(raws[1]?.rawValue as Uint8Array)]).toEqual([1, 2, 3]);
    expect(raws[2]?.rawValue).not.toBe(rawUrl);
    expect(URL.prototype.toString.call(raws[2]?.rawValue)).toBe(
      "https://example.com/raw"
    );
  });

  it("bounds aggregate JSON retained by raw stream parts", async () => {
    const excessive = chunkModel([
      { type: "stream-start", warnings: [] },
      ...Array.from({ length: 6 }, () => ({
        type: "raw" as const,
        rawValue: { items: Array.from({ length: 9000 }, () => ({})) },
      })),
    ]);
    const fallback = textModel(["recovered"]);

    const out = await runFallback([excessive, fallback]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(out.parts.some((part) => part.type === "raw")).toBe(false);
  });

  it("rolls back discarded pre-commit JSON budget before fallback", async () => {
    const failed = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "raw", rawValue: { payload: "x".repeat(3_500_000) } },
      { type: "error", error: new Error("retryable") },
    ]);
    const survivor = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "raw", rawValue: { payload: "y".repeat(1_000_000) } },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "recovered" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([failed, survivor]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(out.parts.filter((part) => part.type === "raw")).toHaveLength(1);
  });

  it("rolls back discarded pre-commit metadata characters", async () => {
    const largeTitle = "x".repeat(65_000);
    const failed = chunkModel([
      { type: "stream-start", warnings: [] },
      ...Array.from({ length: 64 }, (_, index) => ({
        id: `call-${index}`,
        title: largeTitle,
        toolName: "tool",
        type: "tool-input-start" as const,
      })),
      { type: "error", error: new Error("retryable") },
    ]);
    const survivor = chunkModel([
      { type: "stream-start", warnings: [] },
      {
        id: "survivor-call",
        title: largeTitle,
        toolName: "tool",
        type: "tool-input-start",
      },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "recovered" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([failed, survivor]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
  });

  it("does NOT fall back after a clean finish even if the transport then drops", async () => {
    // A completed stream (finish emitted) followed by a read rejection is just the
    // connection closing — the request already succeeded; do not re-run it.
    const primary = new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock",
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "1" });
            controller.enqueue({
              type: "text-delta",
              id: "1",
              delta: "done",
            });
            controller.enqueue({ type: "text-end", id: "1" });
            controller.enqueue({ type: "finish", finishReason, usage });
          },
          pull() {
            throw new Error("ECONNRESET");
          },
        }),
      }),
    });
    const secondary = textModel(["SHOULD NOT RUN"]);
    const outcomes: Array<readonly [boolean, boolean, boolean]> = [];

    const out = await runFallback([primary, secondary], {
      onRequestOutcome: (...outcome) => outcomes.push(outcome),
    });
    expect(out.error).toBeUndefined();
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect(out.parts.filter((p) => p.type === "finish")).toHaveLength(1);
    expect(outcomes).toEqual([[true, false, false]]);
  });

  it("closes downstream when finish arrives even if upstream never closes", async () => {
    let cancelled = false;
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "1" });
            controller.enqueue({ type: "text-delta", id: "1", delta: "done" });
            controller.enqueue({ type: "text-end", id: "1" });
            controller.enqueue({ type: "finish", finishReason, usage });
          },
          cancel() {
            cancelled = true;
          },
        }),
      }),
    });

    const out = await runFallback([primary]);
    expect(out.text).toBe("done");
    expect(cancelled).toBe(true);
  });

  it("reports phase stream-mid for a post-content failure when retryAfterOutput=true", async () => {
    const primary = errorPartModel(new Error("503"), ["partial "]);
    const secondary = textModel(["secondary"]);
    const seen: Array<{ phase?: string; willRetry?: boolean }> = [];

    await runFallback([primary, secondary], {
      retryAfterOutput: true,
      onError: (info) =>
        seen.push({ phase: info.phase, willRetry: info.willRetry }),
    });

    expect(seen).toContainEqual({ phase: "stream-mid", willRetry: true });
  });
});
