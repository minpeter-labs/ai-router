import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  collectStream,
  errorPartStreamModel,
  finishReason,
  okModel,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("recovers a provider family across credential keys after one generate probe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    const family = new MockLanguageModelV4({
      doGenerate: () =>
        healthy
          ? Promise.resolve({
              content: [{ text: "family recovered", type: "text" }],
              finishReason,
              usage,
              warnings: [],
            })
          : Promise.reject(new Error("family unavailable")),
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-generate-recovery",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          okModel("first fallback"),
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          okModel("second fallback"),
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "outage" })
    ).resolves.toMatchObject({ text: "first fallback" });
    await expect(
      generateText({ model: route("second"), prompt: "skip" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(family.doGenerateCalls).toHaveLength(1);

    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    await expect(
      generateText({ model: route("first"), prompt: "probe" })
    ).resolves.toMatchObject({ text: "family recovered" });
    await expect(
      generateText({ model: route("second"), prompt: "shared recovery" })
    ).resolves.toMatchObject({ text: "family recovered" });

    expect(family.doGenerateCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    expect(
      route.getAdmissionSnapshot().every(({ inFlight }) => inFlight === 0)
    ).toBe(true);
    vi.useRealTimers();
  });

  it("recovers a provider family across credential keys after one stream probe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    const failedStream = errorPartStreamModel(new Error("family unavailable"));
    const recoveredStream = streamingModel(["family recovered"]);
    const family = new MockLanguageModelV4({
      doStream: (options) =>
        healthy
          ? recoveredStream.doStream(options)
          : failedStream.doStream(options),
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-stream-recovery",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["first fallback"]),
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["second fallback"]),
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "outage" }))
    ).resolves.toBe("first fallback");
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "skip" }))
    ).resolves.toBe("second fallback");
    expect(family.doStreamCalls).toHaveLength(1);

    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    await expect(
      collectStream(streamText({ model: route("first"), prompt: "probe" }))
    ).resolves.toBe("family recovered");
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "shared recovery" })
      )
    ).resolves.toBe("family recovered");

    expect(family.doStreamCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    expect(
      route.getAdmissionSnapshot().every(({ inFlight }) => inFlight === 0)
    ).toBe(true);
    vi.useRealTimers();
  });
});
