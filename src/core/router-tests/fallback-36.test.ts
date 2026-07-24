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
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("does not claim a stream family probe when retry budget blocks fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const familyError = new Error("family unavailable");
    const blockerError = new Error("blocked stream primary failed");
    let familyHealthy = false;
    const failedFamily = errorPartStreamModel(familyError);
    const recoveredFamily = streamingModel(["family recovered"]);
    const family = new MockLanguageModelV4({
      doStream: (options) =>
        familyHealthy
          ? recoveredFamily.doStream(options)
          : failedFamily.doStream(options),
    });
    const blocker = errorPartStreamModel(blockerError);
    const route = createRouter({
      fallback: {
        classifyFailure: (error) => ({
          retryable: true,
          scope: error === familyError ? "provider-family" : "transient",
        }),
        health: true,
        healthNamespace: "family-stream-budget-probe",
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
          streamingModel(["seed fallback"]),
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
      collectStream(streamText({ model: route("seed"), prompt: "seed outage" }))
    ).resolves.toBe("seed fallback");
    familyHealthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const blocked = asV4(route("blocked"));
    const budget = Reflect.get(blocked, "retryBudget") as {
      observe: (success: boolean) => void;
    };
    budget.observe(false);

    await expect(
      collectStream(streamText({ model: blocked, prompt: "blocked" }))
    ).rejects.toBe(blockerError);
    expect(blocker.doStreamCalls).toHaveLength(1);
    expect(family.doStreamCalls).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    await expect(
      collectStream(streamText({ model: route("probe"), prompt: "probe" }))
    ).resolves.toBe("family recovered");
    expect(family.doStreamCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().filter(({ key }) => key.includes(":family:"))
    ).toEqual([]);
    vi.useRealTimers();
  });

  it("does not claim a family probe when maxAttempts blocks the fallback", async () => {
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
    const events: Array<{
      attempt?: number;
      index: number;
      outcome: string;
    }> = [];
    const route = createRouter({
      fallback: {
        classifyFailure: (error) => ({
          retryable: true,
          scope: error === familyError ? "provider-family" : "transient",
        }),
        health: true,
        healthNamespace: "family-max-attempts-probe",
        maxAttempts: 1,
      },
      models: {
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
        seed: [
          {
            healthKey: "family-key-seed",
            model: family,
            providerFamily: "shared-family",
          },
        ],
      },
      onAttempt: ({ attempt, index, outcome }) =>
        events.push({ attempt, index, outcome }),
    });

    await expect(
      generateText({ model: route("seed"), prompt: "seed outage" })
    ).rejects.toBe(familyError);
    events.length = 0;
    familyHealthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));

    await expect(
      generateText({ model: route("blocked"), prompt: "blocked" })
    ).rejects.toThrow("blocked logical primary failed");
    expect(blocker.doGenerateCalls).toHaveLength(1);
    expect(family.doGenerateCalls).toHaveLength(1);
    expect(events).toEqual([
      { attempt: 1, index: 0, outcome: "failure" },
      { attempt: undefined, index: 1, outcome: "skipped" },
    ]);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    await expect(
      generateText({ model: route("probe"), prompt: "probe" })
    ).resolves.toMatchObject({ text: "family recovered" });
    expect(family.doGenerateCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().filter(({ key }) => key.includes(":family:"))
    ).toEqual([]);
    vi.useRealTimers();
  });
});
