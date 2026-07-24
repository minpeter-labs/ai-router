import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectRawStream,
  collectStream,
  errorPartStreamModel,
  failingModel,
  finishReason,
  genOptions,
  readErrorStreamModel,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("does not claim a stream family probe when maxAttempts blocks fallback", async () => {
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
    const blocker = readErrorStreamModel(blockerError, "partial");
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
        healthNamespace: "family-stream-max-attempts-probe",
        maxAttempts: 1,
        retryAfterOutput: true,
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
      collectStream(streamText({ model: route("seed"), prompt: "seed outage" }))
    ).rejects.toBe(familyError);
    events.length = 0;
    familyHealthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));

    const blocked = await asV4(route("blocked")).doStream(genOptions);
    const { error: blockedError, text: partial } = await collectRawStream(
      blocked.stream
    );
    expect(partial).toBe("partial");
    expect(blockedError).toBe(blockerError);
    expect(blocker.doStreamCalls).toHaveLength(1);
    expect(family.doStreamCalls).toHaveLength(1);
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
      collectStream(streamText({ model: route("probe"), prompt: "probe" }))
    ).resolves.toBe("family recovered");
    expect(family.doStreamCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().filter(({ key }) => key.includes(":family:"))
    ).toEqual([]);
    vi.useRealTimers();
  });

  it("does not claim a credential probe when maxAttempts blocks fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const credentialError = new Error("credential unavailable");
    let credentialHealthy = false;
    const credential = new MockLanguageModelV4({
      doGenerate: () =>
        credentialHealthy
          ? Promise.resolve({
              content: [{ text: "credential recovered", type: "text" }],
              finishReason,
              usage,
              warnings: [],
            })
          : Promise.reject(credentialError),
    });
    const blocker = failingModel("blocked logical primary failed");
    const route = createRouter({
      fallback: {
        classifyFailure: (error) => ({
          retryable: true,
          scope: error === credentialError ? "credential" : "transient",
        }),
        health: true,
        healthNamespace: "credential-max-attempts-probe",
        maxAttempts: 1,
      },
      models: {
        blocked: [
          blocker,
          { healthKey: "shared-credential", model: credential },
        ],
        probe: [{ healthKey: "shared-credential", model: credential }],
        seed: [{ healthKey: "shared-credential", model: credential }],
      },
    });

    await expect(
      generateText({ model: route("seed"), prompt: "seed outage" })
    ).rejects.toBe(credentialError);
    credentialHealthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:01:00.001Z"));

    await expect(
      generateText({ model: route("blocked"), prompt: "blocked" })
    ).rejects.toThrow("blocked logical primary failed");
    expect(blocker.doGenerateCalls).toHaveLength(1);
    expect(credential.doGenerateCalls).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    await expect(
      generateText({ model: route("probe"), prompt: "probe" })
    ).resolves.toMatchObject({ text: "credential recovered" });
    expect(credential.doGenerateCalls).toHaveLength(2);
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toEqual([]);
    vi.useRealTimers();
  });
});
