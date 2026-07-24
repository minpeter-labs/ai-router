import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  collectStream,
  errorPartStreamModel,
  failingModelStatus,
  okModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("shares the longest stream-open quota reset until it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const limited = new MockLanguageModelV4({
      doStream: () =>
        Promise.reject(
          Object.assign(new Error("stream credential limited"), {
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
        healthNamespace: "stream-quota-reset",
      },
      models: {
        first: [
          { healthKey: "shared-key", model: limited },
          {
            healthKey: "first-fallback",
            model: streamingModel(["first fallback"]),
          },
        ],
        second: [
          { healthKey: "shared-key", model: limited },
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
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "shared cooldown" })
      )
    ).resolves.toBe("second fallback");
    expect(limited.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:01:59.999Z"));
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "still cooling" })
      )
    ).resolves.toBe("second fallback");
    expect(limited.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.001Z"));
    await expect(
      collectStream(
        streamText({ model: route("first"), prompt: "probe after reset" })
      )
    ).resolves.toBe("first fallback");
    expect(limited.doStreamCalls).toHaveLength(2);
  });

  it("shares wrapped credential-cause health across logical models", async () => {
    const wrapped = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          Object.assign(new Error("gateway request failed"), {
            cause: Object.assign(new Error("credential limited"), {
              responseHeaders: { "retry-after-ms": "125" },
              statusCode: 429,
            }),
          })
        ),
    });
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "production",
      },
      models: {
        first: [
          { healthKey: "shared-key", model: wrapped },
          { healthKey: "first-fallback", model: okModel("first fallback") },
        ],
        second: [
          { healthKey: "shared-key", model: wrapped },
          { healthKey: "second-fallback", model: okModel("second fallback") },
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "one" })
    ).resolves.toMatchObject({ text: "first fallback" });
    await expect(
      generateText({ model: route("second"), prompt: "two" })
    ).resolves.toMatchObject({ text: "second fallback" });

    expect(wrapped.doGenerateCalls).toHaveLength(1);
    const records = route
      .getHealthSnapshot()
      .filter(({ key }) => key.includes(":credential:"));
    expect(records).toHaveLength(1);
    expect(records[0].record.lastStatus).toBe(429);
  });

  it("shares wrapped stream credential-cause health across logical models", async () => {
    const wrappedFailure = Object.assign(new Error("gateway stream failed"), {
      cause: Object.assign(new Error("credential limited"), {
        responseHeaders: { "retry-after-ms": "125" },
        statusCode: 429,
      }),
    });
    const wrapped = errorPartStreamModel(wrappedFailure);
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "production-stream",
      },
      models: {
        first: [
          { healthKey: "shared-key", model: wrapped },
          {
            healthKey: "first-fallback",
            model: streamingModel(["first fallback"]),
          },
        ],
        second: [
          { healthKey: "shared-key", model: wrapped },
          {
            healthKey: "second-fallback",
            model: streamingModel(["second fallback"]),
          },
        ],
      },
    });

    expect(
      await collectStream(streamText({ model: route("first"), prompt: "one" }))
    ).toBe("first fallback");
    expect(
      await collectStream(streamText({ model: route("second"), prompt: "two" }))
    ).toBe("second fallback");

    expect(wrapped.doStreamCalls).toHaveLength(1);
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(1);
  });

  it("does not share model-specific WAF cooldowns across logical models", async () => {
    const blocked = failingModelStatus(403, "upstream_waf_blocked");
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "production",
      },
      models: {
        first: [
          { model: blocked, healthKey: "shared-key" },
          { model: okModel("first fallback"), healthKey: "first-fallback" },
        ],
        second: [
          { model: blocked, healthKey: "shared-key" },
          { model: okModel("second fallback"), healthKey: "second-fallback" },
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "one" })
    ).resolves.toMatchObject({ text: "first fallback" });
    await expect(
      generateText({ model: route("second"), prompt: "two" })
    ).resolves.toMatchObject({ text: "second fallback" });

    expect(blocked.doGenerateCalls).toHaveLength(2);
    const keys = route.getHealthSnapshot().map(({ key }) => key);
    expect(keys.filter((key) => key.includes(":unit:")).length).toBe(2);
    expect(keys.some((key) => key.includes(":credential:"))).toBe(false);
  });

  it("uses a monotonic token when attempts start in the same millisecond", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      const route = createRouter({
        fallback: { health: true },
        models: {
          chat: [
            { model: failingModelStatus(429), healthKey: "one" },
            { model: failingModelStatus(429), healthKey: "two" },
            { model: okModel("ok"), healthKey: "three" },
          ],
        },
      });
      await generateText({ model: route("chat"), prompt: "same clock" });
      const tokens = route
        .getHealthSnapshot("chat")
        .map(({ record }) => record.lastFailureAt)
        .filter((value) => value !== undefined);

      expect(new Set(tokens).size).toBe(2);
      expect(tokens.every((token) => typeof token === "string")).toBe(true);
    } finally {
      now.mockRestore();
    }
  });
});
