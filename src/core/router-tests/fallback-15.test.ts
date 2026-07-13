import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  errorPartStreamModel,
  failingModel,
  genOptions,
  okModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — fallback", () => {
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
      doStream: () =>
        Promise.resolve({
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
});
