import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import { wrapStreamResult } from "../stream";
import { callOptions, chunkModel, errorPartModel, resolved } from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
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
});
