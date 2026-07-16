import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import { okModel } from "./test-kit";

describe("createRouter — lazy instantiation & caching", () => {
  it("caches a permanent invalid-model factory result across fallbacks", async () => {
    let invalidFactoryCalls = 0;
    const fallback = okModel("fallback");
    const route = createRouter({
      models: {
        chat: [
          {
            provider: () => {
              invalidFactoryCalls += 1;
              return { specificationVersion: "v3" } as never;
            },
            model: "invalid",
          },
          fallback,
        ],
      },
    });

    await generateText({ model: route("chat"), prompt: "one" });
    await generateText({ model: route("chat"), prompt: "two" });

    expect(invalidFactoryCalls).toBe(1);
    expect(fallback.doGenerateCalls).toHaveLength(2);
  });

  it("reuses a permanent invalid-model error without retrying its factory during health cooldown", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let factoryCalls = 0;
      const fallback = okModel("fallback");
      const route = createRouter({
        fallback: { health: true },
        models: {
          chat: [
            {
              model: "invalid",
              provider: () => {
                factoryCalls += 1;
                return { specificationVersion: "v3" } as never;
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
      expect(factoryCalls).toBe(1);
      expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(1);

      await expect(
        generateText({ model: route("chat"), prompt: "cooling" })
      ).resolves.toMatchObject({
        text: "fallback",
      });
      expect(factoryCalls).toBe(1);
      expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(1);

      now = route.getHealthSnapshot("chat")[0].record.cooldownUntil + 1;
      await expect(
        generateText({ model: route("chat"), prompt: "recheck" })
      ).resolves.toMatchObject({
        text: "fallback",
      });
      expect(factoryCalls).toBe(1);
      expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(2);
      expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects and caches a v4-shaped model missing doGenerate", async () => {
    let factoryCalls = 0;
    const fallback = okModel("fallback");
    const route = createRouter({
      models: {
        chat: [
          {
            provider: () => {
              factoryCalls += 1;
              return {
                doStream: () => Promise.reject(new Error("unused")),
                modelId: "incomplete",
                provider: "broken",
                specificationVersion: "v4",
                supportedUrls: {},
              } as never;
            },
            model: "incomplete",
          },
          fallback,
        ],
      },
    });

    await generateText({ model: route("chat"), prompt: "one" });
    await generateText({ model: route("chat"), prompt: "two" });

    expect(factoryCalls).toBe(1);
    expect(fallback.doGenerateCalls).toHaveLength(2);
  });

  it("consumes async required model slots and rejects non-string identity", async () => {
    let asyncFactoryCalls = 0;
    const asyncFallback = okModel("async slot fallback");
    const asyncRoute = createRouter({
      models: {
        chat: [
          {
            model: "async-slots",
            provider: () => {
              asyncFactoryCalls += 1;
              return {
                doGenerate: Promise.reject(new Error("async generate slot")),
                doStream: Promise.reject(new Error("async stream slot")),
                modelId: Promise.reject(new Error("async model id")),
                provider: Promise.reject(new Error("async provider id")),
                specificationVersion: "v4",
              } as never;
            },
          },
          asyncFallback,
        ],
      },
    });

    await expect(
      generateText({ model: asyncRoute("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "async slot fallback" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asyncFactoryCalls).toBe(1);

    const identityFallback = okModel("identity fallback");
    const identityRoute = createRouter({
      models: {
        chat: [
          {
            model: "invalid-identity",
            provider: () =>
              ({
                doGenerate: () => Promise.reject(new Error("unused")),
                doStream: () => Promise.reject(new Error("unused")),
                modelId: 42,
                provider: {},
                specificationVersion: "v4",
              }) as never,
          },
          identityFallback,
        ],
      },
    });
    await expect(
      generateText({ model: identityRoute("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "identity fallback" });
  });

  it("does not cache a throwing factory and releases admission", async () => {
    let factoryCalls = 0;
    const fallback = okModel("fallback");
    const route = createRouter({
      models: {
        chat: [
          {
            healthKey: "factory",
            maxConcurrency: 1,
            model: "throwing",
            provider: () => {
              factoryCalls += 1;
              throw new Error("factory temporarily unavailable");
            },
          },
          fallback,
        ],
      },
    });

    await generateText({ model: route("chat"), prompt: "one" });
    await generateText({ model: route("chat"), prompt: "two" });

    expect(factoryCalls).toBe(2);
    expect(fallback.doGenerateCalls).toHaveLength(2);
  });
});
