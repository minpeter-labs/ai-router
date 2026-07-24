import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  collectStream,
  failingModel,
  failingStreamModel,
  finishReason,
  okModel,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — cooldown (P1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is stateless by default: every request re-probes the failing primary", async () => {
    const primary = failingModel("503 overloaded");
    const secondary = okModel("secondary");
    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
    });
    const routed = route("chat");
    await generateText({ model: routed, prompt: "a" });
    await generateText({ model: routed, prompt: "b" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("sticks to the survivor and re-probes the primary after modelResetInterval", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const primary = failingModel("503 overloaded");
    const secondary = okModel("secondary");
    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
      fallback: { cooldown: true },
    });
    const routed = route("chat");

    // Request 1: primary fails, secondary serves -> survivor becomes the secondary.
    await generateText({ model: routed, prompt: "a" });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);

    // Request 2: starts directly at the sticky survivor; the dead primary is skipped.
    await generateText({ model: routed, prompt: "b" });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(2);

    // After the reset interval elapses, the next request re-probes the primary.
    vi.setSystemTime(new Date("2026-01-01T00:04:00Z")); // +4 min > default 3 min
    await generateText({ model: routed, prompt: "c" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("falls back to earlier candidates when the sticky survivor fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let primaryHealthy = false;
    let stickyHealthy = true;
    const primary = new MockLanguageModelV4({
      doGenerate: () => {
        if (!primaryHealthy) {
          return Promise.reject(new Error("primary unavailable"));
        }
        return Promise.resolve({
          content: [{ type: "text", text: "recovered-primary" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const secondary = failingModel("secondary unavailable");
    const sticky = new MockLanguageModelV4({
      doGenerate: () => {
        if (!stickyHealthy) {
          return Promise.reject(new Error("sticky unavailable"));
        }
        return Promise.resolve({
          content: [{ type: "text", text: "sticky" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const route = createRouter({
      fallback: { cooldown: true },
      models: { chat: [primary, secondary, sticky] },
    });

    expect(
      (await generateText({ model: route("chat"), prompt: "first" })).text
    ).toBe("sticky");
    primaryHealthy = true;
    stickyHealthy = false;
    vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));

    expect(
      (await generateText({ model: route("chat"), prompt: "second" })).text
    ).toBe("recovered-primary");
    expect(primary.doGenerateCalls).toHaveLength(2);
    expect(sticky.doGenerateCalls).toHaveLength(2);
  });

  it("retains earlier stream fallbacks after a sticky stream opener fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let primaryHealthy = false;
    let stickyHealthy = true;
    const primary = new MockLanguageModelV4({
      doStream: () => {
        if (!primaryHealthy) {
          throw new Error("primary unavailable");
        }
        return streamingModel(["recovered-primary"]).doStream({} as never);
      },
    });
    const secondary = failingStreamModel("secondary unavailable");
    const sticky = new MockLanguageModelV4({
      doStream: () => {
        if (!stickyHealthy) {
          throw new Error("sticky unavailable");
        }
        return streamingModel(["sticky"]).doStream({} as never);
      },
    });
    const route = createRouter({
      fallback: { cooldown: true },
      models: { chat: [primary, secondary, sticky] },
    });

    expect(
      await collectStream(streamText({ model: route("chat"), prompt: "first" }))
    ).toBe("sticky");
    primaryHealthy = true;
    stickyHealthy = false;
    vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));

    expect(
      await collectStream(
        streamText({ model: route("chat"), prompt: "second" })
      )
    ).toBe("recovered-primary");
    expect(primary.doStreamCalls).toHaveLength(2);
    expect(sticky.doStreamCalls).toHaveLength(2);
  });

  it("keeps the sticky head fixed while round-robin rotates its fallback tail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let stickyHealthy = true;
    const attempts: number[] = [];
    const sticky = new MockLanguageModelV4({
      doGenerate: () =>
        stickyHealthy
          ? Promise.resolve({
              content: [{ type: "text", text: "sticky" }],
              finishReason,
              usage,
              warnings: [],
            })
          : Promise.reject(new Error("sticky unavailable")),
    });
    const route = createRouter({
      fallback: { cooldown: true, selection: "round-robin" },
      models: {
        chat: [
          failingModel("primary unavailable"),
          failingModel("secondary unavailable"),
          sticky,
        ],
      },
      onAttempt: ({ index, outcome }) => {
        if (outcome === "failure") {
          attempts.push(index);
        }
      },
    });

    await generateText({ model: route("chat"), prompt: "establish sticky" });
    stickyHealthy = false;
    attempts.length = 0;
    vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));
    await expect(
      generateText({ model: route("chat"), prompt: "tail one" })
    ).rejects.toThrow();
    expect(attempts).toEqual([2, 0, 1]);

    attempts.length = 0;
    vi.setSystemTime(new Date("2026-01-01T00:00:47Z"));
    await expect(
      generateText({ model: route("chat"), prompt: "tail two" })
    ).rejects.toThrow();
    expect(attempts).toEqual([2, 1, 0]);
  });
});
