import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";
import {
  MemoryRouterHealthStore,
  RouterHealthUnavailableError,
} from "../health-store";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  errorPartStreamModel,
  failingModel,
  failingModelStatus,
  genOptions,
  okModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("discovers pre-request shared credential records without exposing identity", () => {
    const store = new MemoryRouterHealthStore();
    store.set("scope:production:credential:secret-key", {
      cooldownUntil: Date.now() + 1000,
      failures: 1,
      observedAtMs: Date.now(),
    });
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "production",
        healthStore: store,
      },
      models: {
        chat: [{ model: okModel(), healthKey: "secret-key" }],
      },
    });

    const snapshot = route.getHealthSnapshot("chat");
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].key).toContain(":credential:#");
    expect(snapshot[0].key).not.toContain("secret-key");
  });

  it("does not bypass active cooldown when every candidate is cooling", async () => {
    const first = failingModelStatus(503, "first down");
    const second = failingModelStatus(503, "second down");
    const skipped: number[] = [];
    const route = createRouter({
      fallback: { health: true },
      models: { chat: [first, second] },
      onAttempt: ({ index, outcome, reason }) => {
        if (outcome === "skipped" && reason === "cooldown") {
          skipped.push(index);
        }
      },
    });
    const model = asV4(route("chat"));

    await expect(model.doGenerate(genOptions)).rejects.toThrow();
    const unavailable = await Promise.resolve(
      model.doGenerate(genOptions)
    ).catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(RouterHealthUnavailableError);
    expect(unavailable).toMatchObject({ code: "health_unavailable" });
    expect(first.doGenerateCalls).toHaveLength(1);
    expect(second.doGenerateCalls).toHaveLength(1);
    expect(skipped).toEqual([0, 1]);
  });

  it("isolates shared health by service namespace", async () => {
    const store = new MemoryRouterHealthStore();
    const primary = failingModel("down");
    const secondary = okModel("ok");
    const create = (healthNamespace: string) =>
      createRouter({
        fallback: { health: true, healthNamespace, healthStore: store },
        models: {
          chat: [
            { model: primary, healthKey: "shared-key" },
            { model: secondary, healthKey: "secondary" },
          ],
        },
      });

    await generateText({ model: create("service-a")("chat"), prompt: "a" });
    await generateText({ model: create("service-b")("chat"), prompt: "b" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("isolates default health stores between router instances", async () => {
    const primary = failingModelStatus(429, "credential limited");
    const create = () =>
      createRouter({
        fallback: { health: true, healthNamespace: "production" },
        models: {
          chat: [
            { healthKey: "shared-key", model: primary },
            { healthKey: "fallback", model: okModel("fallback") },
          ],
        },
      });

    await generateText({ model: create()("chat"), prompt: "one" });
    await generateText({ model: create()("chat"), prompt: "two" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("shares default provider-family health across logical models", async () => {
    const familyFailure = failingModel("family unavailable");
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "production-family",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: familyFailure,
            providerFamily: "shared-family",
          },
          {
            healthKey: "first-fallback",
            model: okModel("first fallback"),
            providerFamily: "first",
          },
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: familyFailure,
            providerFamily: "shared-family",
          },
          {
            healthKey: "second-fallback",
            model: okModel("second fallback"),
            providerFamily: "second",
          },
        ],
      },
    });

    await generateText({ model: route("first"), prompt: "one" });
    await generateText({ model: route("second"), prompt: "two" });

    expect(familyFailure.doGenerateCalls).toHaveLength(1);
    expect(
      route.getHealthSnapshot().filter(({ key }) => key.includes(":family:"))
    ).toHaveLength(1);
    expect(
      route.getHealthSnapshot().some(({ key }) => key.includes(":credential:"))
    ).toBe(false);
  });

  it("shares stream provider-family outage across credential keys", async () => {
    const familyFailure = errorPartStreamModel(new Error("family unavailable"));
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "production-stream-family",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: familyFailure,
            providerFamily: "shared-family",
          },
          {
            healthKey: "first-fallback",
            model: streamingModel(["first fallback"]),
            providerFamily: "first",
          },
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: familyFailure,
            providerFamily: "shared-family",
          },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second fallback"]),
            providerFamily: "second",
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "one" }))
    ).resolves.toBe("first fallback");
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "two" }))
    ).resolves.toBe("second fallback");

    expect(familyFailure.doStreamCalls).toHaveLength(1);
    expect(
      route.getHealthSnapshot().filter(({ key }) => key.includes(":family:"))
    ).toHaveLength(1);
    expect(
      route.getHealthSnapshot().some(({ key }) => key.includes(":credential:"))
    ).toBe(false);
  });
});
