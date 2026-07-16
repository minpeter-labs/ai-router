import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import type { Modality } from "../types";
import { okModel } from "./test-kit";

describe("createRouter — configuration errors", () => {
  it("rejects malformed candidate capability and identity configuration eagerly", () => {
    expect(() =>
      createRouter({
        models: {
          chat: [{ model: okModel(), supports: "text" } as never],
        },
      })
    ).toThrow("unknown modality");
    expect(() =>
      createRouter({
        models: {
          chat: [{ model: okModel(), supports: new Array(1) } as never],
        },
      })
    ).toThrow("unknown modality");
    expect(() =>
      createRouter({
        models: {
          chat: [{ model: okModel(), supports: new Array(7) } as never],
        },
      })
    ).toThrow("unknown modality");
    expect(() =>
      createRouter({
        models: {
          chat: [{ healthKey: 42, model: okModel() } as never],
        },
      })
    ).toThrow("healthKey must be a string");
    expect(() =>
      createRouter({
        models: {
          chat: [{ adaptiveConcurrency: "yes", model: okModel() } as never],
        },
      })
    ).toThrow("adaptiveConcurrency must be");
    expect(() =>
      createRouter({
        models: {
          chat: [{ adaptiveConcurrency: null, model: okModel() } as never],
        },
      })
    ).toThrow("adaptiveConcurrency must be");
    expect(() =>
      createRouter({
        models: {
          chat: [{ adaptiveConcurrency: [], model: okModel() } as never],
        },
      })
    ).toThrow("adaptiveConcurrency must be");
    expect(() =>
      createRouter({
        models: {
          chat: [
            { adaptiveConcurrency: new Date(), model: okModel() } as never,
          ],
        },
      })
    ).toThrow("adaptiveConcurrency must be");
    expect(() =>
      createRouter({
        models: {
          chat: [{ adaptiveConcurrency: { max: 1e300 }, model: okModel() }],
        },
      })
    ).toThrow("adaptiveConcurrency requires positive integers");
    expect(() =>
      createRouter({
        models: { chat: [{ maxConcurrency: 1e300, model: okModel() }] },
      })
    ).toThrow("maxConcurrency must be a positive integer");
    expect(() =>
      createRouter({
        models: {
          chat: [{ model: okModel(), supports: null } as never],
        },
      })
    ).toThrow("unknown modality");
    expect(() =>
      createRouter({
        models: {
          chat: [{ healthKey: "x".repeat(257), model: okModel() }],
        },
      })
    ).toThrow("healthKey must be at most 256 characters");
    expect(() =>
      createRouter({
        fallback: { healthNamespace: 42 as never },
        models: { chat: [okModel()] },
      })
    ).toThrow("healthNamespace must be a string");
    expect(() =>
      createRouter({
        fallback: { healthNamespace: "x".repeat(257) },
        models: { chat: [okModel()] },
      })
    ).toThrow("healthNamespace must be at most 256 characters");
  });

  it("snapshots supports without calling extension methods or iterators", async () => {
    const supports = ["text"] as Modality[];
    Object.defineProperties(supports, {
      every: {
        value: () => {
          throw new Error("must not call every");
        },
      },
      [Symbol.iterator]: {
        value: () => {
          throw new Error("must not iterate");
        },
      },
    });
    const route = createRouter({
      models: { chat: [{ model: okModel("safe"), supports }] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "safe" });
  });

  it("consumes Promise-valued bounded routing configuration", async () => {
    expect(() =>
      createRouter({
        models: {
          chat: [
            {
              model: okModel(),
              supports: [
                Promise.reject(new Error("async supports entry")),
              ] as never,
            },
          ],
        },
      })
    ).toThrow("unknown modality");
    expect(() =>
      createRouter({
        models: {
          chat: [
            {
              adaptiveConcurrency: {
                increaseAfterSuccesses: Promise.reject(
                  new Error("async increase threshold")
                ),
                initial: Promise.reject(new Error("async initial limit")),
                max: Promise.reject(new Error("async max limit")),
                min: Promise.reject(new Error("async min limit")),
              } as never,
              model: okModel(),
            },
          ],
        },
      })
    ).toThrow("synchronous");
    expect(() =>
      createRouter({
        fallback: {
          retryBudget: {
            maxSamples: Promise.reject(new Error("async max samples")),
            minSamples: Promise.reject(new Error("async min samples")),
            recoveryFailureRate: Promise.reject(
              new Error("async recovery rate")
            ),
            tripFailureRate: Promise.reject(new Error("async trip rate")),
            window: Promise.reject(new Error("async budget window")),
          } as never,
        },
        models: { chat: [okModel()] },
      })
    ).toThrow("synchronous");
    expect(() =>
      createRouter({
        models: {
          chat: [
            {
              adaptiveConcurrency: Promise.reject(
                new Error("async entry adaptive config")
              ),
              healthKey: Promise.reject(new Error("async entry health key")),
              maxConcurrency: Promise.reject(
                new Error("async entry concurrency")
              ),
              model: Promise.reject(new Error("async entry model")),
              provider: Promise.reject(new Error("async entry provider")),
              providerFamily: Promise.reject(
                new Error("async entry provider family")
              ),
              supports: Promise.reject(new Error("async entry supports")),
            } as never,
          ],
        },
      })
    ).toThrow("synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots candidate arrays without calling extension methods or iterators", async () => {
    const entries = [{ model: okModel("safe") }];
    Object.defineProperties(entries, {
      map: {
        value: () => {
          throw new Error("must not call map");
        },
      },
      [Symbol.iterator]: {
        value: () => {
          throw new Error("must not iterate");
        },
      },
    });
    const route = createRouter({ models: { chat: entries } });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "safe" });
  });
});
