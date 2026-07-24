import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  errorPartStreamModel,
  genOptions,
  streamingModel,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("reports consumer cancel while waiting for routed fallback admission", async () => {
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
    const fallback = streamingModel(["must not open"]);
    const attempts: Array<{
      attempt?: number;
      inFlight?: number;
      index: number;
      limit?: number;
      outcome: string;
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
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 1,
              max: 2,
              min: 1,
            },
            healthKey: "shared-wait-consumer-cancel",
            model: held,
          },
        ],
        chat: [
          errorPartStreamModel(new Error("primary stream failed")),
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 1,
              max: 2,
              min: 1,
            },
            healthKey: "shared-wait-consumer-cancel",
            model: fallback,
          },
        ],
      },
      onAttempt: ({ attempt, concurrencyLimit, inFlight, index, outcome }) =>
        attempts.push({
          attempt,
          inFlight,
          index,
          limit: concurrencyLimit,
          outcome,
        }),
    });
    const heldResult = await asV4(route("hold")).doStream(genOptions);
    const heldReader = heldResult.stream.getReader();
    for (let reads = 0; reads < 3; reads++) {
      await heldReader.read();
    }
    const caller = new AbortController();
    const result = await asV4(route("chat")).doStream({
      ...genOptions,
      abortSignal: caller.signal,
    });
    const reader = result.stream.getReader();
    const pendingRead = reader.read();
    await vi.waitFor(() =>
      expect(route.getAdmissionSnapshot("chat")[1].waiting).toBe(1)
    );

    await reader.cancel("consumer stopped routed admission wait");
    caller.abort(new Error("late caller abort after consumer cancel"));
    await pendingRead;
    await vi.waitFor(() => expect(attempts).toHaveLength(2));

    expect(attempts).toEqual([
      {
        attempt: 1,
        inFlight: 1,
        index: 0,
        limit: undefined,
        outcome: "failure",
      },
      {
        attempt: undefined,
        inFlight: 1,
        index: 1,
        limit: 1,
        outcome: "cancelled",
      },
    ]);
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      adaptive: true,
      inFlight: 1,
      limit: 1,
      successes: 0,
      waiting: 0,
    });
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
    expect(fallback.doStreamCalls).toHaveLength(0);

    await heldReader.cancel("release held capacity");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      adaptive: true,
      inFlight: 0,
      limit: 1,
      successes: 0,
      waiting: 0,
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "retry" }))
    ).resolves.toBe("must not open");
    expect(fallback.doStreamCalls).toHaveLength(1);
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      adaptive: true,
      inFlight: 0,
      limit: 1,
      successes: 1,
      waiting: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
  });
});
