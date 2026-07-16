import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouterHealthStore } from "../health-store";
import { createRouter } from "../router";
import {
  asV4,
  failingModel,
  failingModelStatus,
  failingStreamModel,
  finishReason,
  genOptions,
  okModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("counts stream-open failures toward the retry budget", async () => {
    const primary = failingStreamModel("primary open failed");
    const secondary = failingStreamModel("secondary open failed");
    const retries: Array<boolean | undefined> = [];
    const route = createRouter({
      fallback: { retryBudget: true },
      models: { chat: [primary, secondary] },
      onError: ({ willRetry }) => retries.push(willRetry),
    });
    const model = asV4(route("chat"));

    for (let request = 0; request < 6; request++) {
      await expect(model.doStream(genOptions)).rejects.toThrow();
    }

    expect(primary.doStreamCalls).toHaveLength(6);
    expect(secondary.doStreamCalls).toHaveLength(5);
    expect(retries.at(-1)).toBe(false);
  });

  it("does not trip the request budget when a deep fallback succeeds", async () => {
    const failures = Array.from({ length: 4 }, (_, index) =>
      failingModel(`failure-${index}`)
    );
    const survivor = okModel("survivor");
    const route = createRouter({
      fallback: { retryBudget: true },
      models: { chat: [...failures, survivor] },
    });
    const model = asV4(route("chat"));

    for (let request = 0; request < 6; request++) {
      await expect(model.doGenerate(genOptions)).resolves.toMatchObject({
        content: [{ type: "text", text: "survivor" }],
      });
    }

    expect(failures[0].doGenerateCalls).toHaveLength(6);
    expect(survivor.doGenerateCalls).toHaveLength(6);
  });

  it("trips the retry budget on repeated credential rate-limit failures", async () => {
    const primary = failingModelStatus(429, "primary limited");
    const secondary = failingModelStatus(429, "secondary limited");
    const route = createRouter({
      fallback: { retryBudget: true },
      models: { chat: [primary, secondary] },
    });

    for (let request = 0; request < 6; request++) {
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).rejects.toThrow();
    }

    expect(primary.doGenerateCalls).toHaveLength(6);
    expect(secondary.doGenerateCalls).toHaveLength(5);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 6,
      tripped: true,
    });
  });

  it("does not charge a cooling candidate against a tripped retry budget", async () => {
    const store = new MemoryRouterHealthStore();
    const primary = failingModelStatus(503, "primary overloaded");
    let secondaryCalls = 0;
    const secondary = new MockLanguageModelV4({
      doGenerate: () => {
        secondaryCalls += 1;
        if (secondaryCalls === 1) {
          return Promise.reject(
            Object.assign(new Error("secondary overloaded"), {
              statusCode: 503,
            })
          );
        }
        return Promise.resolve({
          content: [{ type: "text", text: "secondary recovered" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
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
      models: { chat: [primary, secondary] },
    });

    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toThrow();
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      samples: 1,
      tripped: true,
    });
    store.delete("logical:chat:unit:1");

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "secondary recovered" }],
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failureRate: 0.5,
      samples: 2,
      tripped: true,
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "secondary recovered" }],
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 1,
      samples: 3,
      tripped: false,
    });

    store.delete("logical:chat:unit:0");
    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "secondary recovered" }],
    });
    expect(primary.doGenerateCalls).toHaveLength(2);
    expect(secondary.doGenerateCalls).toHaveLength(4);
  });

  it("does not charge a saturated candidate against a tripped retry budget", async () => {
    let resolvePrimary:
      | ((result: LanguageModelV4GenerateResult) => void)
      | undefined;
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          resolvePrimary = resolve;
        }),
    });
    const secondary = okModel("capacity fallback");
    const route = createRouter({
      fallback: {
        retryBudget: {
          minSamples: 1,
          recoveryFailureRate: 0.4,
          tripFailureRate: 1,
        },
      },
      models: {
        chat: [{ maxConcurrency: 1, model: primary }, secondary],
      },
    });
    const routed = asV4(route("chat"));
    const occupying = routed.doGenerate(genOptions);
    await vi.waitFor(() => expect(resolvePrimary).toBeTypeOf("function"));
    const budget = Reflect.get(routed, "retryBudget") as {
      observe: (success: boolean) => void;
    };
    budget.observe(false);

    await expect(routed.doGenerate(genOptions)).resolves.toMatchObject({
      content: [{ type: "text", text: "capacity fallback" }],
    });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);

    resolvePrimary?.({
      content: [{ type: "text", text: "primary done" }],
      finishReason,
      usage,
      warnings: [],
    });
    await occupying;
  });
});
