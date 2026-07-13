import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
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
});
