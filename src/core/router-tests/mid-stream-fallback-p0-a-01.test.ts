import { streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  collectStream,
  errorPartStreamModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — mid-stream fallback (P0-A)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares the longest pre-output stream error reset until expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = Object.assign(new Error("credential limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const primary = errorPartStreamModel(failure);
    const route = createRouter({
      fallback: { health: true, healthNamespace: "pre-output-reset" },
      models: {
        first: [
          { healthKey: "shared-key", model: primary },
          {
            healthKey: "first-fallback",
            model: streamingModel(["first"]),
          },
        ],
        second: [
          { healthKey: "shared-key", model: primary },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second"]),
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "initial" }))
    ).resolves.toBe("first");
    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "cooling" }))
    ).resolves.toBe("second");
    expect(primary.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(streamText({ model: route("first"), prompt: "probe" }))
    ).resolves.toBe("first");
    expect(primary.doStreamCalls).toHaveLength(2);
  });

  it("propagates post-output credential failure into shared health", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = Object.assign(new Error("credential limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          chunks: [
            { type: "stream-start", warnings: [] },
            { id: "primary", type: "text-start" },
            { delta: "partial ", id: "primary", type: "text-delta" },
            { type: "error", error: failure },
          ],
        }),
      }),
    });
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "post-output",
        retryAfterOutput: true,
      },
      models: {
        first: [
          { healthKey: "shared-key", model: primary },
          {
            healthKey: "first-fallback",
            model: streamingModel(["secondary"]),
          },
        ],
        second: [
          { healthKey: "shared-key", model: primary },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second"]),
          },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "one" }))
    ).resolves.toBe("partial secondary");
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "two" }))
    ).resolves.toBe("second");

    expect(primary.doStreamCalls).toHaveLength(1);
    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "cooling" }))
    ).resolves.toBe("second");
    expect(primary.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(streamText({ model: route("first"), prompt: "probe" }))
    ).resolves.toBe("partial secondary");
    expect(primary.doStreamCalls).toHaveLength(2);
    const credential = route
      .getHealthSnapshot()
      .filter(({ key }) => key.includes(":credential:"));
    expect(credential).toHaveLength(1);
    expect(credential[0].record.lastStatus).toBe(429);
  });

  it("learns shared cooldown when post-output retry is disabled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const failure = Object.assign(
      new Error("credential limited after output"),
      {
        responseHeaders: {
          "x-ratelimit-reset-requests": "90s",
          "x-ratelimit-reset-tokens": "120s",
        },
        statusCode: 429,
      }
    );
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { id: "primary", type: "text-start" },
            { delta: "partial", id: "primary", type: "text-delta" },
            { type: "error", error: failure },
          ],
        }),
      }),
    });
    const seen: unknown[] = [];
    const route = createRouter({
      fallback: { health: true, healthNamespace: "no-post-output-retry" },
      models: {
        first: [
          { healthKey: "shared-key", model: primary },
          {
            healthKey: "first-fallback",
            model: streamingModel(["first fallback"]),
          },
        ],
        second: [
          { healthKey: "shared-key", model: primary },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second fallback"]),
          },
        ],
      },
      onError: ({ error }) => seen.push(error),
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "initial" }))
    ).resolves.toBe("partial");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(seen).toEqual([failure]);

    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      collectStream(streamText({ model: route("second"), prompt: "cooling" }))
    ).resolves.toBe("second fallback");
    expect(primary.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(streamText({ model: route("first"), prompt: "probe" }))
    ).resolves.toBe("partial");
    expect(primary.doStreamCalls).toHaveLength(2);
    expect(seen).toEqual([failure, failure]);
  });
});
