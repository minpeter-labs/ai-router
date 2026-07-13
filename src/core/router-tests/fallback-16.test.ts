import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import { asV4, collectStream, genOptions, streamingModel } from "./test-kit";

describe("createRouter — fallback", () => {
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
});
