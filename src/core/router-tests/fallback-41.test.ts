import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouterHealthStore } from "../health-store";
import { createRouter } from "../router";
import {
  asV4,
  failingModel,
  failingModelStatus,
  finishReason,
  genOptions,
  okModel,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("releases a cancelled half-open stream probe immediately", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let cancels = 0;
    const openStream = () =>
      new ReadableStream<LanguageModelV4StreamPart>({
        cancel() {
          cancels += 1;
        },
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ id: "1", type: "text-start" });
          controller.enqueue({
            delta: "probe",
            id: "1",
            type: "text-delta",
          });
        },
      });
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(Object.assign(new Error("down"), { statusCode: 503 })),
      doStream: async () => ({ stream: openStream() }),
    });
    const fallbackStream = streamingModel(["fallback"]);
    const fallback = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ text: "fallback", type: "text" }],
        finishReason,
        usage,
        warnings: [],
      }),
      doStream: (options) => fallbackStream.doStream(options),
    });
    const route = createRouter({
      fallback: { health: true },
      models: { chat: [primary, fallback] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "cool" })
    ).resolves.toMatchObject({ text: "fallback" });
    vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));

    const first = await asV4(route("chat")).doStream(genOptions);
    const firstReader = first.stream.getReader();
    await firstReader.read();
    await firstReader.read();
    await firstReader.read();
    expect(
      route
        .getHealthSnapshot("chat")
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(true);
    await firstReader.cancel("consumer stopped");
    expect(
      route
        .getHealthSnapshot("chat")
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    const second = await asV4(route("chat")).doStream(genOptions);
    await second.stream.cancel("second consumer stopped");
    expect(primary.doStreamCalls).toHaveLength(2);
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
    expect(cancels).toBe(2);
  });

  it("does not collide when namespace and logical-id segment boundaries differ", async () => {
    const store = new MemoryRouterHealthStore();
    const primary = failingModel("down");
    const secondary = okModel("ok");
    const first = createRouter({
      fallback: { health: true, healthNamespace: "a", healthStore: store },
      models: { "b:c": [primary, secondary] },
    });
    const second = createRouter({
      fallback: { health: true, healthNamespace: "a:b", healthStore: store },
      models: { c: [primary, secondary] },
    });

    await generateText({ model: first("b:c"), prompt: "one" });
    await generateText({ model: second("c"), prompt: "two" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("shares credential health across logical models in one explicit namespace", async () => {
    const store = new MemoryRouterHealthStore();
    const limited = failingModelStatus(429, "credential limited");
    const firstFallback = okModel("first fallback");
    const secondFallback = okModel("second fallback");
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "production",
        healthStore: store,
      },
      models: {
        first: [
          { model: limited, healthKey: "shared-key" },
          { model: firstFallback, healthKey: "first-fallback" },
        ],
        second: [
          { model: limited, healthKey: "shared-key" },
          { model: secondFallback, healthKey: "second-fallback" },
        ],
      },
    });

    await generateText({ model: route("first"), prompt: "one" });
    await generateText({ model: route("second"), prompt: "two" });

    expect(limited.doGenerateCalls).toHaveLength(1);
    expect(secondFallback.doGenerateCalls).toHaveLength(1);
    const keys = route.getHealthSnapshot().map(({ key }) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((key) => key.includes("shared-key"))).toBe(false);
    expect(keys.some((key) => key.includes(":credential:#"))).toBe(true);
  });

  it("shares the longest credential quota reset until it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const limited = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          Object.assign(new Error("credential limited"), {
            responseHeaders: {
              "x-ratelimit-reset-requests": "90s",
              "x-ratelimit-reset-tokens": "120s",
            },
            statusCode: 429,
          })
        ),
    });
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "quota-reset",
      },
      models: {
        first: [
          { healthKey: "shared-key", model: limited },
          { healthKey: "first-fallback", model: okModel("first fallback") },
        ],
        second: [
          { healthKey: "shared-key", model: limited },
          { healthKey: "second-fallback", model: okModel("second fallback") },
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "initial" })
    ).resolves.toMatchObject({ text: "first fallback" });
    await expect(
      generateText({ model: route("second"), prompt: "shared cooldown" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(limited.doGenerateCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      generateText({ model: route("second"), prompt: "still cooling" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(limited.doGenerateCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      generateText({ model: route("first"), prompt: "probe after reset" })
    ).resolves.toMatchObject({ text: "first fallback" });
    expect(limited.doGenerateCalls).toHaveLength(2);
  });
});
