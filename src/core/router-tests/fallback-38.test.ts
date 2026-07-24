import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  collectStream,
  errorPartStreamModel,
  okModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("does not claim a stream credential probe when maxAttempts blocks fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const credentialError = new Error("credential unavailable");
    const blockerError = new Error("blocked stream primary failed");
    let credentialHealthy = false;
    const failedCredential = errorPartStreamModel(credentialError);
    const recoveredCredential = streamingModel(["credential recovered"]);
    const credential = new MockLanguageModelV4({
      doStream: (options) =>
        credentialHealthy
          ? recoveredCredential.doStream(options)
          : failedCredential.doStream(options),
    });
    const blocker = errorPartStreamModel(blockerError);
    const route = createRouter({
      fallback: {
        classifyFailure: (error) => ({
          retryable: true,
          scope: error === credentialError ? "credential" : "transient",
        }),
        health: true,
        healthNamespace: "credential-stream-max-attempts-probe",
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
      collectStream(streamText({ model: route("seed"), prompt: "seed outage" }))
    ).rejects.toBe(credentialError);
    credentialHealthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:01:00.001Z"));

    await expect(
      collectStream(streamText({ model: route("blocked"), prompt: "blocked" }))
    ).rejects.toBe(blockerError);
    expect(blocker.doStreamCalls).toHaveLength(1);
    expect(credential.doStreamCalls).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);

    await expect(
      collectStream(streamText({ model: route("probe"), prompt: "probe" }))
    ).resolves.toBe("credential recovered");
    expect(credential.doStreamCalls).toHaveLength(2);
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toEqual([]);
    vi.useRealTimers();
  });

  it("keeps credential 429 cooldown isolated within one provider family", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const limited = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          Object.assign(new Error("first key limited"), {
            responseHeaders: {
              "x-ratelimit-reset-requests": "90s",
              "x-ratelimit-reset-tokens": "120s",
            },
            statusCode: 429,
          })
        ),
    });
    const sibling = okModel("sibling key");
    const route = createRouter({
      fallback: { health: true, healthNamespace: "family-credentials" },
      models: {
        chat: [
          {
            healthKey: "key-a",
            model: limited,
            providerFamily: "friendli",
          },
          {
            healthKey: "key-b",
            model: sibling,
            providerFamily: "friendli",
          },
        ],
      },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "first" })
    ).resolves.toMatchObject({ text: "sibling key" });
    await expect(
      generateText({ model: route("chat"), prompt: "second" })
    ).resolves.toMatchObject({ text: "sibling key" });
    expect(limited.doGenerateCalls).toHaveLength(1);
    expect(sibling.doGenerateCalls).toHaveLength(2);
    expect(
      route
        .getHealthSnapshot("chat")
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot("chat")
        .some(({ key }) => key.includes(":family:"))
    ).toBe(false);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      generateText({ model: route("chat"), prompt: "probe" })
    ).resolves.toMatchObject({ text: "sibling key" });
    expect(limited.doGenerateCalls).toHaveLength(2);
    expect(sibling.doGenerateCalls).toHaveLength(3);
    vi.useRealTimers();
  });

  it("keeps stream credential cooldown isolated within one provider family", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = Object.assign(new Error("first stream key limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const limited = errorPartStreamModel(failure);
    const sibling = streamingModel(["sibling stream key"]);
    const route = createRouter({
      fallback: { health: true, healthNamespace: "family-stream-credentials" },
      models: {
        chat: [
          {
            healthKey: "key-a",
            model: limited,
            providerFamily: "friendli",
          },
          {
            healthKey: "key-b",
            model: sibling,
            providerFamily: "friendli",
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "first" }))
    ).resolves.toBe("sibling stream key");
    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "second" }))
    ).resolves.toBe("sibling stream key");
    expect(limited.doStreamCalls).toHaveLength(1);
    expect(sibling.doStreamCalls).toHaveLength(2);
    expect(
      route
        .getHealthSnapshot("chat")
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot("chat")
        .some(({ key }) => key.includes(":family:"))
    ).toBe(false);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "probe" }))
    ).resolves.toBe("sibling stream key");
    expect(limited.doStreamCalls).toHaveLength(2);
    expect(sibling.doStreamCalls).toHaveLength(3);
    vi.useRealTimers();
  });
});
