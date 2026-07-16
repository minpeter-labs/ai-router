import type {
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  errorPartStreamModel,
  genOptions,
  streamingModel,
} from "./test-kit";

describe("createRouter — fallback", () => {
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
});
