import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  errorPartStreamModel,
  failingModel,
  finishReason,
  genOptions,
  okModel,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("censors a family stream probe open stopped by total timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let mode: "fail" | "hang" | "recover" = "fail";
    const failedStream = errorPartStreamModel(new Error("family unavailable"));
    const recoveredStream = streamingModel(["family recovered"]);
    const family = new MockLanguageModelV4({
      doStream: (options) => {
        if (mode === "fail") {
          return failedStream.doStream(options);
        }
        return mode === "hang"
          ? new Promise<never>(() => undefined)
          : recoveredStream.doStream(options);
      },
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-stream-total-timeout",
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

    const initial = collectStream(
      streamText({ model: route("first"), prompt: "outage" })
    );
    await vi.runAllTimersAsync();
    await expect(initial).resolves.toBe("first fallback");
    mode = "hang";
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const probe = asV4(route("first")).doStream(genOptions);
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
    const sibling = collectStream(
      streamText({ model: route("second"), prompt: "sibling probe" })
    );
    await vi.runAllTimersAsync();
    await expect(sibling).resolves.toBe("family recovered");
    expect(family.doStreamCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    vi.useRealTimers();
  });

  it("does not claim a family probe when retry budget blocks the fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const familyError = new Error("family unavailable");
    let familyHealthy = false;
    const family = new MockLanguageModelV4({
      doGenerate: () =>
        familyHealthy
          ? Promise.resolve({
              content: [{ text: "family recovered", type: "text" }],
              finishReason,
              usage,
              warnings: [],
            })
          : Promise.reject(familyError),
    });
    const blocker = failingModel("blocked logical primary failed");
    const route = createRouter({
      fallback: {
        classifyFailure: (error) => ({
          retryable: true,
          scope: error === familyError ? "provider-family" : "transient",
        }),
        health: true,
        healthNamespace: "family-budget-probe",
        retryBudget: {
          minSamples: 1,
          recoveryFailureRate: 0.4,
          tripFailureRate: 1,
        },
      },
      models: {
        seed: [
          {
            healthKey: "family-key-seed",
            model: family,
            providerFamily: "shared-family",
          },
          okModel("seed fallback"),
        ],
        blocked: [
          blocker,
          {
            healthKey: "family-key-blocked",
            model: family,
            providerFamily: "shared-family",
          },
        ],
        probe: [
          {
            healthKey: "family-key-probe",
            model: family,
            providerFamily: "shared-family",
          },
        ],
      },
    });

    await expect(
      generateText({ model: route("seed"), prompt: "seed outage" })
    ).resolves.toMatchObject({ text: "seed fallback" });
    familyHealthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const blocked = asV4(route("blocked"));
    const budget = Reflect.get(blocked, "retryBudget") as {
      observe: (success: boolean) => void;
    };
    budget.observe(false);

    await expect(blocked.doGenerate(genOptions)).rejects.toThrow(
      "blocked logical primary failed"
    );
    expect(blocker.doGenerateCalls).toHaveLength(1);
    expect(family.doGenerateCalls).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    await expect(
      generateText({ model: route("probe"), prompt: "healthy budget probe" })
    ).resolves.toMatchObject({ text: "family recovered" });
    expect(family.doGenerateCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().filter(({ key }) => key.includes(":family:"))
    ).toEqual([]);
    vi.useRealTimers();
  });
});
