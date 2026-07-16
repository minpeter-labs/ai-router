import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
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
  it("recools a family after a stream probe first-content timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let hang = false;
    const failedStream = errorPartStreamModel(new Error("family unavailable"));
    const family = new MockLanguageModelV4({
      doStream: (options) =>
        hang
          ? Promise.resolve({
              stream: new ReadableStream<LanguageModelV4StreamPart>(),
            })
          : failedStream.doStream(options),
    });
    const firstFallback = streamingModel(["first fallback"]);
    const secondFallback = streamingModel(["second fallback"]);
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        firstContentTimeout: 10,
        health: true,
        healthNamespace: "family-first-content-timeout",
        retryBudget: true,
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          firstFallback,
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          secondFallback,
        ],
      },
    });

    const initial = collectStream(
      streamText({ model: route("first"), prompt: "outage" })
    );
    await vi.runAllTimersAsync();
    await expect(initial).resolves.toBe("first fallback");
    hang = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const probe = collectStream(
      streamText({ model: route("first"), prompt: "probe" })
    );
    for (
      let turns = 0;
      turns < 20 && family.doStreamCalls.length < 2;
      turns++
    ) {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    }
    expect(family.doStreamCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10);
    await vi.runAllTimersAsync();
    await expect(probe).resolves.toBe("first fallback");

    expect(family.doStreamCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(2);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 2,
    });

    const sibling = collectStream(
      streamText({ model: route("second"), prompt: "still cooling" })
    );
    await vi.runAllTimersAsync();
    await expect(sibling).resolves.toBe("second fallback");
    expect(family.doStreamCalls).toHaveLength(2);
    vi.useRealTimers();
  });

  it("censors a family generate probe stopped by total timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let mode: "fail" | "hang" | "recover" = "fail";
    const recovered = (): LanguageModelV4GenerateResult => ({
      content: [{ text: "family recovered", type: "text" }],
      finishReason,
      usage,
      warnings: [],
    });
    const family = new MockLanguageModelV4({
      doGenerate: () => {
        if (mode === "fail") {
          return Promise.reject(new Error("family unavailable"));
        }
        return mode === "hang"
          ? new Promise<never>(() => undefined)
          : Promise.resolve(recovered());
      },
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-generate-total-timeout",
        retryBudget: true,
        totalTimeout: 10,
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
    mode = "hang";
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const probe = generateText({ model: route("first"), prompt: "probe" });
    const probeExpectation = expect(probe).rejects.toMatchObject({
      code: "total_timeout",
    });
    await vi.advanceTimersByTimeAsync(10);
    await probeExpectation;

    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    mode = "recover";
    await expect(
      generateText({ model: route("second"), prompt: "sibling probe" })
    ).resolves.toMatchObject({ text: "family recovered" });
    expect(family.doGenerateCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    vi.useRealTimers();
  });
});
