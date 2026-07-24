import { streamText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  collectStream,
  readErrorStreamModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — mid-stream fallback (P0-A)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("discards prelude and recovers from a pre-output read rejection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = Object.assign(new Error("pre-output read limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const primary = readErrorStreamModel(failure, null);
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "pre-output-read-error",
        retryBudget: true,
      },
      models: {
        first: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          {
            healthKey: "first-fallback",
            model: streamingModel(["first fallback"]),
          },
        ],
        second: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second fallback"]),
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "initial" }))
    ).resolves.toBe("first fallback");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(route.getAdmissionSnapshot("first")[0].inFlight).toBe(0);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "cooling" }))
    ).resolves.toBe("second fallback");
    expect(primary.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(streamText({ model: route("first"), prompt: "probe" }))
    ).resolves.toBe("first fallback");
    expect(primary.doStreamCalls).toHaveLength(2);
    expect(route.getAdmissionSnapshot("first")[0].inFlight).toBe(0);
  });

  it("settles a post-output read rejection without retrying the current stream", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = Object.assign(new Error("read credential limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const primary = readErrorStreamModel(failure);
    const attempts: Array<{
      inFlight?: number;
      outcome: string;
      phase?: string;
    }> = [];
    const seen: unknown[] = [];
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "read-error-no-retry",
        retryBudget: true,
      },
      models: {
        first: [
          {
            healthKey: "shared-key",
            maxConcurrency: 1,
            model: primary,
          },
          {
            healthKey: "first-fallback",
            model: streamingModel(["must not run"]),
          },
        ],
        second: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second fallback"]),
          },
        ],
      },
      onAttempt: ({ inFlight, outcome, phase }) => {
        attempts.push({ inFlight, outcome, phase });
      },
      onError: ({ error }) => seen.push(error),
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "initial" }))
    ).rejects.toBe(failure);
    expect(seen).toEqual([failure]);
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(route.getAdmissionSnapshot("first")[0].inFlight).toBe(0);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 1,
      samples: 1,
    });
    expect(attempts).toContainEqual({
      inFlight: 1,
      outcome: "failure",
      phase: "stream-mid",
    });

    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "cooling" }))
    ).resolves.toBe("second fallback");
    expect(primary.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "probe" }))
    ).rejects.toBe(failure);
    expect(primary.doStreamCalls).toHaveLength(2);
    expect(route.getAdmissionSnapshot("second")[0].inFlight).toBe(0);
  });

  it("falls back after a post-output read rejection when enabled", async () => {
    const failure = Object.assign(new Error("read credential limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const primary = readErrorStreamModel(failure);
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "read-error-retry",
        retryAfterOutput: true,
        retryBudget: true,
      },
      models: {
        first: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          {
            healthKey: "first-fallback",
            model: streamingModel([" fallback"]),
          },
        ],
        second: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second"]),
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "initial" }))
    ).resolves.toBe("partial fallback");
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "shared" }))
    ).resolves.toBe("second");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(route.getAdmissionSnapshot("first")[0].inFlight).toBe(0);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
  });
});
