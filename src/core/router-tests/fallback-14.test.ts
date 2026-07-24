import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { streamText } from "ai";
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
});
