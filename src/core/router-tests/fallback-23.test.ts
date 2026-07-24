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
  failingModelStatus,
  genOptions,
  okModel,
  readErrorStreamModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("rechecks shared health before each fallback attempt", async () => {
    const rejectPrimary: Array<(reason?: unknown) => void> = [];
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((_, reject) => {
          rejectPrimary.push(reject);
        }),
    });
    const secondary = failingModelStatus(429, "secondary limited");
    const tertiary = okModel("tertiary");
    const route = createRouter({
      fallback: { health: true },
      models: {
        chat: [
          { model: primary, healthKey: "primary" },
          { model: secondary, healthKey: "secondary" },
          { model: tertiary, healthKey: "tertiary" },
        ],
      },
    });
    const requests = ["a", "b", "c"].map((prompt) =>
      generateText({ model: route("chat"), prompt })
    );
    await vi.waitFor(() => expect(rejectPrimary).toHaveLength(3));

    rejectPrimary[0](
      Object.assign(new Error("primary limited"), { statusCode: 429 })
    );
    await vi.waitFor(() => expect(secondary.doGenerateCalls).toHaveLength(1));
    await vi.waitFor(() => expect(tertiary.doGenerateCalls).toHaveLength(1));
    rejectPrimary[1](
      Object.assign(new Error("primary limited"), { statusCode: 429 })
    );
    rejectPrimary[2](
      Object.assign(new Error("primary limited"), { statusCode: 429 })
    );

    await expect(Promise.all(requests)).resolves.toHaveLength(3);
    expect(secondary.doGenerateCalls).toHaveLength(1);
    expect(tertiary.doGenerateCalls).toHaveLength(3);
  });

  it("emits attempt-level observability events", async () => {
    const events: Array<{ outcome: string; willRetry?: boolean }> = [];
    const route = createRouter({
      models: { chat: [failingModel("down"), okModel("ok")] },
      onAttempt: ({ outcome, willRetry }) =>
        events.push({ outcome, willRetry }),
    });

    await generateText({ model: route("chat"), prompt: "hi" });
    expect(events).toEqual([
      { outcome: "failure", willRetry: true },
      { outcome: "success", willRetry: undefined },
    ]);
  });

  it("omits attempt numbers from events that did not call a provider", async () => {
    const events: Array<{ attempt?: number; outcome: string }> = [];
    const route = createRouter({
      fallback: { maxAttempts: 1 },
      models: { chat: [failingModel("down"), okModel("skipped")] },
      onAttempt: ({ attempt, outcome }) => events.push({ attempt, outcome }),
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).rejects.toThrow("down");
    expect(events).toEqual([
      { attempt: 1, outcome: "failure" },
      { attempt: undefined, outcome: "skipped" },
    ]);
  });

  it("does not instantiate factories skipped by maxAttempts", async () => {
    const generateError = new Error("generate failed");
    const streamError = new Error("stream failed");
    const failedStream = errorPartStreamModel(streamError);
    const primary = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(generateError),
      doStream: (options) => failedStream.doStream(options),
    });
    let factoryCalls = 0;
    const events: Array<{
      attempt?: number;
      outcome: string;
      phase: string;
    }> = [];
    const route = createRouter({
      fallback: { maxAttempts: 1 },
      models: {
        chat: [
          primary,
          {
            model: "lazy-fallback",
            provider: () => {
              factoryCalls += 1;
              return okModel("must stay lazy");
            },
            supports: ["text"],
          },
        ],
      },
      onAttempt: ({ attempt, outcome, phase }) =>
        events.push({ attempt, outcome, phase }),
    });

    await expect(
      generateText({ model: route("chat"), prompt: "generate" })
    ).rejects.toBe(generateError);
    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "stream" }))
    ).rejects.toBe(streamError);

    expect(factoryCalls).toBe(0);
    expect(events).toEqual([
      { attempt: 1, outcome: "failure", phase: "generate" },
      { attempt: undefined, outcome: "skipped", phase: "generate" },
      { attempt: 1, outcome: "failure", phase: "stream-open" },
      { attempt: undefined, outcome: "skipped", phase: "stream-open" },
    ]);
  });

  it("preserves partial output without instantiating a maxAttempts-blocked factory", async () => {
    const streamError = new Error("post-output stream failed");
    const primary = readErrorStreamModel(streamError, "partial");
    let factoryCalls = 0;
    const events: Array<{
      attempt?: number;
      outcome: string;
      phase: string;
      reason?: string;
    }> = [];
    const route = createRouter({
      fallback: { maxAttempts: 1, retryAfterOutput: true },
      models: {
        chat: [
          primary,
          {
            model: "lazy-fallback",
            provider: () => {
              factoryCalls += 1;
              return streamingModel(["must not run"]);
            },
            supports: ["text"],
          },
        ],
      },
      onAttempt: ({ attempt, outcome, phase, reason }) =>
        events.push({ attempt, outcome, phase, reason }),
    });

    const result = await asV4(route("chat")).doStream(genOptions);
    const { error: caught, text } = await collectRawStream(result.stream);

    expect(text).toBe("partial");
    expect(caught).toBe(streamError);
    expect(factoryCalls).toBe(0);
    expect(events).toEqual([
      {
        attempt: 1,
        outcome: "failure",
        phase: "stream-mid",
        reason: undefined,
      },
      {
        attempt: undefined,
        outcome: "skipped",
        phase: "stream-mid",
        reason: "max-attempts",
      },
    ]);
  });
});
