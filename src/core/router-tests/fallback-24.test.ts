import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectRawStream,
  collectStream,
  failingModel,
  finishReason,
  genOptions,
  okModel,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("settles post-output error-part health and budget when maxAttempts blocks fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const streamError = Object.assign(new Error("credential limited"), {
      responseHeaders: {
        "x-ratelimit-reset-requests": "90s",
        "x-ratelimit-reset-tokens": "120s",
      },
      statusCode: 429,
    });
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { id: "primary", type: "text-start" },
            { delta: "partial", id: "primary", type: "text-delta" },
            { error: streamError, type: "error" },
          ],
        }),
      }),
    });
    let blockedFactoryCalls = 0;
    const events: Array<{
      attempt?: number;
      outcome: string;
      phase: string;
      reason?: string;
    }> = [];
    const route = createRouter({
      fallback: {
        health: true,
        healthNamespace: "post-output-error-part-max-attempts",
        maxAttempts: 1,
        retryAfterOutput: true,
        retryBudget: true,
      },
      models: {
        first: [
          { healthKey: "shared-key", model: primary },
          {
            model: "blocked-fallback",
            provider: () => {
              blockedFactoryCalls += 1;
              return streamingModel(["must not run"]);
            },
            supports: ["text"],
          },
        ],
        second: [
          { healthKey: "shared-key", model: primary },
          streamingModel(["cooldown fallback"]),
        ],
      },
      onAttempt: ({ attempt, outcome, phase, reason }) =>
        events.push({ attempt, outcome, phase, reason }),
    });

    const result = await asV4(route("first")).doStream(genOptions);
    const { error: caught, text } = await collectRawStream(result.stream);

    expect(text).toBe("partial");
    expect(caught).toBe(streamError);
    expect(blockedFactoryCalls).toBe(0);
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
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 1,
      samples: 1,
    });
    expect(route.getAdmissionSnapshot("first")[0].inFlight).toBe(0);
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(1);

    await expect(
      collectStream(streamText({ model: route("second"), prompt: "cooling" }))
    ).resolves.toBe("cooldown fallback");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(route.getRetryBudgetSnapshot("second")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
    expect(route.getAdmissionSnapshot("second")[1].inFlight).toBe(0);
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(1);
    vi.useRealTimers();
  });

  it("isolates rejected async observability hooks", async () => {
    const route = createRouter({
      models: { chat: [failingModel("down"), okModel("recovered")] },
      onAttempt: () => Promise.reject(new Error("async attempt hook failed")),
      onError: () => Promise.reject(new Error("async error hook failed")),
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "recovered" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("reports willRetry false when every remaining candidate is at capacity", async () => {
    let releaseHolder:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const holder = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          releaseHolder = resolve;
        }),
    });
    const retryCandidate = okModel("must not run");
    const decisions: Array<boolean | undefined> = [];
    const route = createRouter({
      models: {
        holder: [{ model: holder, healthKey: "shared", maxConcurrency: 1 }],
        chat: [
          failingModel("primary failed"),
          {
            model: retryCandidate,
            healthKey: "shared",
            maxConcurrency: 1,
          },
        ],
      },
      onError: ({ logicalId, willRetry }) => {
        if (logicalId === "chat") {
          decisions.push(willRetry);
        }
      },
    });

    const held = asV4(route("holder")).doGenerate(genOptions);
    await vi.waitFor(() => expect(holder.doGenerateCalls).toHaveLength(1));
    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toThrow(
      "primary failed"
    );

    expect(decisions).toEqual([false]);
    expect(retryCandidate.doGenerateCalls).toHaveLength(0);
    releaseHolder?.({
      content: [{ type: "text", text: "done" }],
      finishReason,
      usage,
      warnings: [],
    });
    await held;
  });

  it("reports willRetry true when the next candidate reuses the released slot", async () => {
    const decisions: Array<boolean | undefined> = [];
    const fallback = okModel("shared-slot fallback");
    const route = createRouter({
      models: {
        chat: [
          {
            healthKey: "shared",
            maxConcurrency: 1,
            model: failingModel("primary failed"),
          },
          { healthKey: "shared", maxConcurrency: 1, model: fallback },
        ],
      },
      onError: ({ willRetry }) => decisions.push(willRetry),
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "shared-slot fallback" });
    expect(decisions).toEqual([true]);
    expect(fallback.doGenerateCalls).toHaveLength(1);
  });

  it("keeps observability indexes stable after modality filtering", async () => {
    const indexes: number[] = [];
    const route = createRouter({
      models: {
        chat: [
          { model: okModel("image"), supports: ["image"] },
          { model: failingModel("down"), supports: ["text"] },
          { model: okModel("ok"), supports: ["text"] },
        ],
      },
      onAttempt: ({ index }) => indexes.push(index),
    });

    await generateText({ model: route("chat"), prompt: "hi" });
    expect(indexes).toEqual([1, 2]);
  });
});
