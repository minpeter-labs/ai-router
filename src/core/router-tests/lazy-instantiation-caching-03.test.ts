import type { LanguageModelV4 } from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import { collectStream, okModel, streamingModel } from "./test-kit";

describe("createRouter — lazy instantiation & caching", () => {
  it("cools a transient factory failure without poisoning AIMD or retry budget recovery", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let factoryCalls = 0;
      const recovered = okModel("factory recovered");
      const fallback = okModel("fallback");
      const route = createRouter({
        fallback: { health: true, retryBudget: true },
        models: {
          chat: [
            {
              adaptiveConcurrency: {
                increaseAfterSuccesses: 2,
                initial: 2,
                max: 4,
                min: 1,
              },
              maxConcurrency: 2,
              model: "transient-factory",
              provider: () => {
                factoryCalls += 1;
                if (factoryCalls === 1) {
                  throw new Error("factory temporarily unavailable");
                }
                return recovered;
              },
            },
            fallback,
          ],
        },
      });

      await expect(
        generateText({ model: route("chat"), prompt: "first" })
      ).resolves.toMatchObject({
        text: "fallback",
      });
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
      });
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 1,
      });

      await expect(
        generateText({ model: route("chat"), prompt: "cooling" })
      ).resolves.toMatchObject({
        text: "fallback",
      });
      expect(factoryCalls).toBe(1);

      now = route.getHealthSnapshot("chat")[0].record.cooldownUntil + 1;
      await expect(
        generateText({ model: route("chat"), prompt: "recover" })
      ).resolves.toMatchObject({
        text: "factory recovered",
      });
      expect(factoryCalls).toBe(2);
      expect(route.getHealthSnapshot("chat")).toEqual([]);
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
        successes: 1,
      });
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 3,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("recovers a transient stream factory failure without leaking ownership", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let factoryCalls = 0;
      const recovered = streamingModel(["factory stream recovered"]);
      const fallback = streamingModel(["stream fallback"]);
      const route = createRouter({
        fallback: { health: true, retryBudget: true },
        models: {
          chat: [
            {
              adaptiveConcurrency: {
                initial: 2,
                max: 4,
                min: 1,
              },
              maxConcurrency: 2,
              model: "transient-stream-factory",
              provider: () => {
                factoryCalls += 1;
                if (factoryCalls === 1) {
                  throw new Error("stream factory temporarily unavailable");
                }
                return recovered;
              },
            },
            fallback,
          ],
        },
      });

      await expect(
        collectStream(streamText({ model: route("chat"), prompt: "first" }))
      ).resolves.toBe("stream fallback");
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
      });
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 1,
      });

      await expect(
        collectStream(streamText({ model: route("chat"), prompt: "cooling" }))
      ).resolves.toBe("stream fallback");
      expect(factoryCalls).toBe(1);

      now = route.getHealthSnapshot("chat")[0].record.cooldownUntil + 1;
      await expect(
        collectStream(streamText({ model: route("chat"), prompt: "recover" }))
      ).resolves.toBe("factory stream recovered");

      expect(factoryCalls).toBe(2);
      expect(recovered.doStreamCalls).toHaveLength(1);
      expect(route.getHealthSnapshot("chat")).toEqual([]);
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
        successes: 1,
      });
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 3,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("does not cache transient model accessor failures", async () => {
    let specificationReads = 0;
    let factoryCalls = 0;
    const recovered = okModel("recovered primary");
    const raw = Object.defineProperties(
      {
        doGenerate: recovered.doGenerate.bind(recovered),
        doStream: recovered.doStream.bind(recovered),
      },
      {
        specificationVersion: {
          get() {
            specificationReads += 1;
            if (specificationReads === 1) {
              throw new Error("model metadata temporarily unavailable");
            }
            return "v4";
          },
        },
      }
    ) as unknown as LanguageModelV4;
    const fallback = okModel("fallback");
    const route = createRouter({
      models: {
        chat: [
          {
            model: "transient",
            provider: () => {
              factoryCalls += 1;
              return raw;
            },
          },
          fallback,
        ],
      },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "one" })
    ).resolves.toMatchObject({ text: "fallback" });
    await expect(
      generateText({ model: route("chat"), prompt: "two" })
    ).resolves.toMatchObject({ text: "recovered primary" });

    expect(factoryCalls).toBe(2);
    expect(specificationReads).toBe(2);
  });
});
