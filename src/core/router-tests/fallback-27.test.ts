import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouterHealthStore } from "../health-store";
import { createRouter } from "../router";
import {
  asV4,
  errorPartStreamModel,
  failingModel,
  failingModelStatus,
  genOptions,
  MAX_ATTEMPTS_RE,
  okModel,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("exposes configured retry budget state per logical model", async () => {
    const route = createRouter({
      fallback: {
        retryBudget: {
          minSamples: 2,
          tripFailureRate: 0.5,
          window: "30s",
        },
      },
      models: { chat: [failingModel("down")] },
    });
    const model = asV4(route("chat"));
    await expect(model.doGenerate(genOptions)).rejects.toThrow("down");
    await expect(model.doGenerate(genOptions)).rejects.toThrow("down");

    expect(route.getRetryBudgetSnapshot("chat")).toEqual([
      expect.objectContaining({
        available: false,
        failureRate: 1,
        failures: 2,
        logicalId: "chat",
        samples: 2,
        tripped: true,
        windowMs: 30_000,
      }),
    ]);
    expect(route.getRetryBudgetSnapshot("unknown")).toEqual([]);
  });

  it("does not count caller aborts against the retry budget", async () => {
    const primary = failingModel("provider failed");
    const secondary = okModel("recovered");
    const route = createRouter({
      fallback: { retryBudget: true },
      models: { chat: [primary, secondary] },
    });
    const model = asV4(route("chat"));

    for (let request = 0; request < 5; request++) {
      const controller = new AbortController();
      controller.abort(new DOMException("cancelled", "AbortError"));
      await expect(
        model.doGenerate({ ...genOptions, abortSignal: controller.signal })
      ).rejects.toMatchObject({ name: "AbortError" });
    }

    await expect(model.doGenerate(genOptions)).resolves.toMatchObject({
      content: [{ type: "text", text: "recovered" }],
    });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });

  it("does not settle the retry budget when a consumer cancels during fallback", async () => {
    const fallback = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
          },
        }),
      }),
    });
    const route = createRouter({
      fallback: { retryBudget: true },
      models: {
        chat: [errorPartStreamModel(new Error("primary failed")), fallback],
      },
    });
    const result = await asV4(route("chat")).doStream(genOptions);
    const reader = result.stream.getReader();
    const pendingRead = reader.read();
    await vi.waitFor(() => expect(fallback.doStreamCalls).toHaveLength(1));

    await reader.cancel("consumer stopped");
    await pendingRead;

    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
  });

  it("caches one routed model per logical id", () => {
    const route = createRouter({ models: { chat: [okModel()] } });
    expect(route("chat")).toBe(route("chat"));
  });

  it("rejects invalid maxAttempts", () => {
    expect(() =>
      createRouter({
        fallback: { maxAttempts: Number.POSITIVE_INFINITY },
        models: { chat: [okModel()] },
      })("chat")
    ).toThrow(MAX_ATTEMPTS_RE);
    expect(() =>
      createRouter({
        fallback: { maxAttempts: 1e300 },
        models: { chat: [okModel()] },
      })
    ).toThrow(MAX_ATTEMPTS_RE);
  });

  it("shares health through an external store and exposes snapshots", async () => {
    const store = new MemoryRouterHealthStore();
    const primary = failingModel("down");
    const secondary = okModel("ok");
    const options = {
      fallback: { health: true, healthStore: store },
      models: { chat: [primary, secondary] },
    };
    const first = createRouter(options);
    await generateText({ model: first("chat"), prompt: "one" });
    expect(first.getHealthSnapshot("chat")).toHaveLength(1);

    const second = createRouter(options);
    await generateText({ model: second("chat"), prompt: "two" });
    expect(primary.doGenerateCalls).toHaveLength(1);
  });

  it("does not retry a failed credential when shared health writes fail", async () => {
    class UnavailableStore extends MemoryRouterHealthStore {
      override get(): never {
        throw new Error("health store unavailable");
      }

      override set(): never {
        throw new Error("health store unavailable");
      }

      override compareAndSet(): never {
        throw new Error("health store unavailable");
      }
    }
    const rateLimited = failingModelStatus(429, "credential rate limited");
    const duplicateCredential = okModel("must be skipped");
    const independentCredential = okModel("independent fallback");
    const route = createRouter({
      fallback: { health: true, healthStore: new UnavailableStore() },
      models: {
        chat: [
          { healthKey: "shared", model: rateLimited },
          { healthKey: "shared", model: duplicateCredential },
          { healthKey: "independent", model: independentCredential },
        ],
      },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "independent fallback" }],
    });
    expect(rateLimited.doGenerateCalls).toHaveLength(1);
    expect(duplicateCredential.doGenerateCalls).toHaveLength(0);
    expect(independentCredential.doGenerateCalls).toHaveLength(1);
  });

  it("reads configured health snapshots before the routed model is requested", () => {
    const store = new MemoryRouterHealthStore();
    store.set("logical:chat:unit:0", {
      cooldownUntil: Date.now() + 1000,
      failures: 1,
      observedAtMs: Date.now(),
    });
    const provider = vi.fn(() => okModel("unused"));
    const route = createRouter({
      fallback: { health: true, healthStore: store },
      models: { chat: [{ provider, model: "model" }] },
    });

    expect(route.getHealthSnapshot("chat")).toHaveLength(1);
    expect(provider).not.toHaveBeenCalled();
  });

  it("isolates public diagnostic snapshots from caller mutation", () => {
    const store = new MemoryRouterHealthStore();
    store.set("logical:chat:unit:0", {
      cooldownUntil: Date.now() + 1000,
      failures: 2,
      observedAtMs: Date.now(),
    });
    const route = createRouter({
      fallback: { health: true, healthStore: store, retryBudget: true },
      models: {
        chat: [
          {
            adaptiveConcurrency: { initial: 2, max: 4, min: 1 },
            model: okModel(),
          },
        ],
      },
    });
    const health = route.getHealthSnapshot("chat");
    const admission = route.getAdmissionSnapshot("chat");
    const budget = route.getRetryBudgetSnapshot("chat");

    health[0].record.failures = 0;
    admission[0].inFlight = 99;
    budget[0].samples = 99;

    expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(2);
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
    expect(route.getRetryBudgetSnapshot("chat")[0].samples).toBe(0);
  });
});
