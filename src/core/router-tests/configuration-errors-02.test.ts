import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import { asV4, genOptions, okModel } from "./test-kit";

describe("createRouter — configuration errors", () => {
  it("snapshots instance routing and health accessors exactly once", async () => {
    const reads = {
      adaptiveConcurrency: 0,
      healthKey: 0,
      maxConcurrency: 0,
      model: 0,
      providerFamily: 0,
      supports: 0,
    };
    const values = {
      adaptiveConcurrency: { initial: 1, max: 2, min: 1 },
      healthKey: "stable-health",
      maxConcurrency: 1,
      model: okModel("stable instance"),
      providerFamily: "stable-family",
      supports: ["text"],
    };
    const entry = {} as Record<string, unknown>;
    for (const key of Object.keys(reads) as Array<keyof typeof reads>) {
      Object.defineProperty(entry, key, {
        configurable: true,
        get() {
          reads[key] += 1;
          return values[key];
        },
      });
    }
    const route = createRouter({ models: { chat: [entry as never] } });
    for (const key of Object.keys(reads)) {
      Object.defineProperty(entry, key, {
        value: () => {
          throw new Error(`${key} mutated accessor must not run`);
        },
      });
    }

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "stable instance" });
    expect(reads).toEqual({
      adaptiveConcurrency: 1,
      healthKey: 1,
      maxConcurrency: 1,
      model: 1,
      providerFamily: 1,
      supports: 1,
    });
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      limit: 1,
      max: 2,
      min: 1,
    });
  });

  it("snapshots router fallback and hook accessors once across logical models", async () => {
    const reads = { fallback: 0, onAttempt: 0, onError: 0 };
    const once =
      <T>(key: keyof typeof reads, value: T) =>
      () => {
        reads[key] += 1;
        if (reads[key] > 1) {
          throw new Error(`${key} read twice`);
        }
        return value;
      };
    const options = Object.defineProperties(
      {
        models: { first: [okModel("first")], second: [okModel("second")] },
      },
      {
        fallback: {
          enumerable: true,
          get: once("fallback", { retryBudget: { minSamples: 2 } }),
        },
        onAttempt: {
          enumerable: true,
          get: once("onAttempt", () => undefined),
        },
        onError: {
          enumerable: true,
          get: once("onError", () => undefined),
        },
      }
    );

    const route = createRouter(options as never);
    await expect(
      generateText({ model: route("first"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "first" });
    await expect(
      generateText({ model: route("second"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "second" });
    expect(reads).toEqual({ fallback: 1, onAttempt: 1, onError: 1 });
  });

  it("ignores unknown fallback extension getters while snapshotting", async () => {
    const fallback = Object.defineProperty({ maxAttempts: 1 }, "unknown", {
      enumerable: true,
      get() {
        throw new Error("unknown option must not be read");
      },
    });
    const route = createRouter({
      fallback: fallback as never,
      models: { chat: [okModel("ok")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "ok" });
  });

  it("ignores unknown adaptive-concurrency getters while snapshotting", async () => {
    const adaptive = Object.defineProperty(
      { initial: 1, max: 2, min: 1 },
      "unknown",
      {
        enumerable: true,
        get() {
          throw new Error("unknown adaptive option must not be read");
        },
      }
    );
    const route = createRouter({
      models: {
        chat: [{ adaptiveConcurrency: adaptive, model: okModel("ok") }],
      },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "ok" });
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      limit: 1,
      max: 2,
      min: 1,
    });
  });

  it("validates custom health-store method contracts eagerly", () => {
    expect(() =>
      createRouter({
        fallback: { healthStore: 42 as never },
        models: { chat: [okModel()] },
      })
    ).toThrow("healthStore must be an object");
    expect(() =>
      createRouter({
        fallback: { healthStore: {} as never },
        models: { chat: [okModel()] },
      })
    ).toThrow("healthStore.delete must be a function");
    expect(() =>
      createRouter({
        fallback: {
          healthStore: {
            compareAndSet: 1,
            delete: vi.fn(),
            get: vi.fn(),
            set: vi.fn(),
          } as never,
        },
        models: { chat: [okModel()] },
      })
    ).toThrow("healthStore.compareAndSet must be a function");
  });

  it("consumes Promise-valued health-store method siblings", async () => {
    expect(() =>
      createRouter({
        fallback: {
          healthStore: {
            compareAndSet: Promise.reject(new Error("async CAS method")),
            delete: Promise.reject(new Error("async delete method")),
            entries: Promise.reject(new Error("async entries method")),
            get: Promise.reject(new Error("async get method")),
            set: Promise.reject(new Error("async set method")),
          } as never,
        },
        models: { chat: [okModel()] },
      })
    ).toThrow("synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("constructs ordering sources when platform entropy is unavailable", async () => {
    const uuid = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(() => {
        throw new Error("crypto unavailable");
      });
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("random unavailable");
    });
    try {
      const route = createRouter({ models: { chat: [okModel("safe")] } });
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).resolves.toMatchObject({ content: [{ text: "safe" }] });
    } finally {
      uuid.mockRestore();
      random.mockRestore();
    }
  });
});
