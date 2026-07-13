import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouterHealthStore } from "../health-store";
import { createRouter } from "../router";
import { asV4, collectStream, genOptions, streamingModel } from "./test-kit";

describe("createRouter — fallback", () => {
  it("does not charge a cooling stream candidate against a tripped retry budget", async () => {
    const store = new MemoryRouterHealthStore();
    store.set("logical:chat:unit:0", {
      cooldownUntil: Date.now() + 60_000,
      failures: 1,
      lastFailureAt: 1,
      observedAtMs: Date.now(),
    });
    const primary = streamingModel(["must not open"]);
    const secondary = streamingModel(["stream fallback"]);
    const attempts: Array<{
      attempt?: number;
      index: number;
      outcome: string;
    }> = [];
    const route = createRouter({
      fallback: {
        health: true,
        healthStore: store,
        retryBudget: {
          minSamples: 1,
          recoveryFailureRate: 0.4,
          tripFailureRate: 1,
        },
      },
      models: { chat: [primary, secondary] },
      onAttempt: ({ attempt, index, outcome }) => {
        attempts.push({ attempt, index, outcome });
      },
    });
    const routed = asV4(route("chat"));
    const budget = Reflect.get(routed, "retryBudget") as {
      observe: (success: boolean) => void;
    };
    budget.observe(false);

    await expect(
      collectStream(streamText({ model: routed, prompt: "stream" }))
    ).resolves.toBe("stream fallback");

    expect(primary.doStreamCalls).toHaveLength(0);
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(attempts).toEqual([
      { attempt: undefined, index: 0, outcome: "skipped" },
      { attempt: 1, index: 1, outcome: "success" },
    ]);
  });

  it("does not recover a tripped retry budget from consumer-cancelled fallback stream", async () => {
    const store = new MemoryRouterHealthStore();
    store.set("logical:chat:unit:0", {
      cooldownUntil: Date.now() + 60_000,
      failures: 1,
      lastFailureAt: 1,
      observedAtMs: Date.now(),
    });
    const primary = streamingModel(["must not open"]);
    const attempts: Array<{ index: number; outcome: string }> = [];
    let transportCancelled = false;
    const secondary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
          },
          cancel() {
            transportCancelled = true;
          },
        }),
      }),
    });
    const route = createRouter({
      fallback: {
        health: true,
        healthStore: store,
        retryBudget: {
          minSamples: 1,
          recoveryFailureRate: 0.4,
          tripFailureRate: 1,
        },
      },
      models: {
        chat: [
          primary,
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: secondary,
          },
        ],
      },
      onAttempt: ({ index, outcome }) => attempts.push({ index, outcome }),
    });
    const routed = asV4(route("chat"));
    const budget = Reflect.get(routed, "retryBudget") as {
      observe: (success: boolean) => void;
    };
    budget.observe(false);
    const result = await routed.doStream(genOptions);
    const reader = result.stream.getReader();
    const pendingRead = reader.read();
    await vi.waitFor(() => expect(secondary.doStreamCalls).toHaveLength(1));

    await reader.cancel("consumer stopped");
    await pendingRead;

    expect(transportCancelled).toBe(true);
    expect(primary.doStreamCalls).toHaveLength(0);
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      successes: 0,
    });
    expect(attempts).toEqual([
      { index: 0, outcome: "skipped" },
      { index: 1, outcome: "cancelled" },
    ]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 1,
      samples: 1,
      tripped: true,
    });
  });

  it("keeps one recovery outcome when consumer cancel follows validated finish", async () => {
    const store = new MemoryRouterHealthStore();
    store.set("logical:chat:unit:0", {
      cooldownUntil: Date.now() + 60_000,
      failures: 1,
      lastFailureAt: 1,
      observedAtMs: Date.now(),
    });
    const primary = streamingModel(["must not open"]);
    const secondary = streamingModel(["finished fallback"]);
    const attempts: Array<{ index: number; outcome: string }> = [];
    const route = createRouter({
      fallback: {
        health: true,
        healthStore: store,
        retryBudget: {
          minSamples: 1,
          recoveryFailureRate: 0.4,
          tripFailureRate: 1,
        },
      },
      models: {
        chat: [
          primary,
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: secondary,
          },
        ],
      },
      onAttempt: ({ index, outcome }) => attempts.push({ index, outcome }),
    });
    const routed = asV4(route("chat"));
    const budget = Reflect.get(routed, "retryBudget") as {
      observe: (success: boolean) => void;
    };
    budget.observe(false);
    const result = await routed.doStream(genOptions);
    const reader = result.stream.getReader();
    let sawFinish = false;
    while (!sawFinish) {
      const next = await reader.read();
      if (next.done) {
        throw new Error("stream closed before finish");
      }
      sawFinish = next.value.type === "finish";
    }

    await reader.cancel("consumer stopped after finish");

    expect(primary.doStreamCalls).toHaveLength(0);
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      successes: 1,
    });
    expect(attempts).toEqual([
      { index: 0, outcome: "skipped" },
      { index: 1, outcome: "success" },
    ]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failureRate: 0.5,
      failures: 1,
      samples: 2,
      tripped: true,
    });
  });
});
