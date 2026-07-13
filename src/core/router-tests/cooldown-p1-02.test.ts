import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  failingModel,
  failingStreamModel,
  genOptions,
  imagePart,
  okModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — cooldown (P1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a sticky stream head fixed while round-robin rotates its fallback tail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let stickyHealthy = true;
    const attempts: number[] = [];
    const healthyStream = streamingModel(["sticky"]);
    const sticky = new MockLanguageModelV4({
      doStream: (options) =>
        stickyHealthy
          ? healthyStream.doStream(options)
          : Promise.reject(new Error("sticky stream unavailable")),
    });
    const route = createRouter({
      fallback: { cooldown: true, selection: "round-robin" },
      models: {
        chat: [
          failingStreamModel("primary stream unavailable"),
          failingStreamModel("secondary stream unavailable"),
          sticky,
        ],
      },
      onAttempt: ({ index, outcome }) => {
        if (outcome === "failure") {
          attempts.push(index);
        }
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "sticky" }))
    ).resolves.toBe("sticky");
    stickyHealthy = false;
    attempts.length = 0;
    vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));
    await expect(asV4(route("chat")).doStream(genOptions)).rejects.toThrow();
    expect(attempts).toEqual([2, 0, 1]);

    attempts.length = 0;
    vi.setSystemTime(new Date("2026-01-01T00:00:47Z"));
    await expect(asV4(route("chat")).doStream(genOptions)).rejects.toThrow();
    expect(attempts).toEqual([2, 1, 0]);
  });

  it("keeps the sticky start position within the modality-filtered set", async () => {
    const a = failingModel("503 overloaded"); // text-only, fullIndex 0
    const b = okModel("b-text"); // text-only, fullIndex 1
    const c = okModel("c-image"); // text+image, fullIndex 2

    const route = createRouter({
      models: {
        chat: [
          { provider: () => a, model: "a", supports: ["text"] },
          { provider: () => b, model: "b", supports: ["text"] },
          { provider: () => c, model: "c", supports: ["text", "image"] },
        ],
      },
      fallback: { cooldown: true },
    });
    const routed = route("chat");

    // Text request: a fails, b serves -> survivor sticky index = 1 (b).
    await generateText({ model: routed, prompt: "text" });
    expect(b.doGenerateCalls).toHaveLength(1);

    // Image request: b (text-only) is filtered out; selection must fall to c
    // (the first surviving filtered candidate), not break on the stale index.
    const { text } = await generateText({
      model: routed,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "describe" }, imagePart],
        },
      ],
    });
    expect(text).toBe("c-image");
    expect(c.doGenerateCalls).toHaveLength(1);
    expect(a.doGenerateCalls).toHaveLength(1); // not retried for the image request
  });

  it("does NOT make a modality-forced candidate sticky over a healthy primary", async () => {
    const a = okModel("a-text"); // text-only, fullIndex 0, HEALTHY (never fails)
    const b = okModel("b-img"); // text+image, fullIndex 1

    const route = createRouter({
      models: {
        chat: [
          { provider: () => a, model: "a", supports: ["text"] },
          { provider: () => b, model: "b", supports: ["text", "image"] },
        ],
      },
      fallback: { cooldown: true },
    });
    const routed = route("chat");

    // Image request: only b is eligible (a is text-only); b serves WITHOUT a failing.
    await generateText({
      model: routed,
      messages: [
        { role: "user", content: [{ type: "text", text: "x" }, imagePart] },
      ],
    });
    expect(b.doGenerateCalls).toHaveLength(1);

    // Text request: the healthy primary `a` must still serve it — b must not have
    // become sticky just because it was the only image-capable candidate earlier.
    const { text } = await generateText({ model: routed, prompt: "hi" });
    expect(text).toBe("a-text");
    expect(a.doGenerateCalls).toHaveLength(1);
    expect(b.doGenerateCalls).toHaveLength(1);
  });
});
