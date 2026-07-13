import { generateText, streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  collectStream,
  errorPartStreamModel,
  failingModel,
  okModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("exponentially recools a family after a failed generate probe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const family = failingModel("family unavailable");
    const firstFallback = okModel("first fallback");
    const secondFallback = okModel("second fallback");
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-generate-recool",
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

    await expect(
      generateText({ model: route("first"), prompt: "outage" })
    ).resolves.toMatchObject({ text: "first fallback" });
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    await expect(
      generateText({ model: route("first"), prompt: "failed probe" })
    ).resolves.toMatchObject({ text: "first fallback" });
    expect(family.doGenerateCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(2);

    vi.setSystemTime(new Date("2026-01-01T00:00:45.000Z"));
    await expect(
      generateText({ model: route("second"), prompt: "still cooling" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(family.doGenerateCalls).toHaveLength(2);

    vi.setSystemTime(new Date("2026-01-01T00:00:45.002Z"));
    await expect(
      generateText({ model: route("second"), prompt: "next probe" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(family.doGenerateCalls).toHaveLength(3);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    vi.useRealTimers();
  });

  it("exponentially recools a family after a failed stream probe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const family = errorPartStreamModel(new Error("family unavailable"));
    const firstFallback = streamingModel(["first fallback"]);
    const secondFallback = streamingModel(["second fallback"]);
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-stream-recool",
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

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "outage" }))
    ).resolves.toBe("first fallback");
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    await expect(
      collectStream(
        streamText({ model: route("first"), prompt: "failed probe" })
      )
    ).resolves.toBe("first fallback");
    expect(family.doStreamCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(2);

    vi.setSystemTime(new Date("2026-01-01T00:00:45.000Z"));
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "still cooling" })
      )
    ).resolves.toBe("second fallback");
    expect(family.doStreamCalls).toHaveLength(2);

    vi.setSystemTime(new Date("2026-01-01T00:00:45.002Z"));
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "next probe" })
      )
    ).resolves.toBe("second fallback");
    expect(family.doStreamCalls).toHaveLength(3);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    vi.useRealTimers();
  });
});
