import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  errorPartStreamModel,
  genOptions,
  streamingModel,
} from "./test-kit";

describe("createRouter — mid-stream fallback (P0-A)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps caller abort authoritative over a later consumer cancel", async () => {
    let readWaiting: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      readWaiting = resolve;
    });
    const upstreamCancelReasons: unknown[] = [];
    const primary = new MockLanguageModelV4({
      doStream: () => {
        let step = 0;
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            cancel(reason) {
              upstreamCancelReasons.push(reason);
            },
            pull(controller) {
              if (step === 0) {
                controller.enqueue({ type: "stream-start", warnings: [] });
              } else if (step === 1) {
                controller.enqueue({ id: "primary", type: "text-start" });
              } else if (step === 2) {
                controller.enqueue({
                  delta: "partial",
                  id: "primary",
                  type: "text-delta",
                });
              } else {
                readWaiting?.();
                return new Promise<void>(() => undefined);
              }
              step += 1;
            },
          }),
        });
      },
    });
    const attempts: Array<{ outcome: string }> = [];
    const route = createRouter({
      fallback: { health: true, retryBudget: true },
      models: {
        chat: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          streamingModel(["must not run"]),
        ],
      },
      onAttempt: ({ outcome }) => attempts.push({ outcome }),
    });
    const caller = new AbortController();
    const callerReason = new Error("caller stopped first");
    const consumerReason = new Error("consumer cancelled second");
    const result = await asV4(route("chat")).doStream({
      ...genOptions,
      abortSignal: caller.signal,
    });
    const reader = result.stream.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    const pending = reader.read();
    await waiting;

    caller.abort(callerReason);
    await reader.cancel(consumerReason);
    await pending;

    expect(upstreamCancelReasons).toEqual([callerReason]);
    expect(attempts).toEqual([]);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
  });

  it("keeps consumer cancel authoritative over a later caller abort", async () => {
    const upstreamCancelReasons: unknown[] = [];
    const primary = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            cancel(reason) {
              upstreamCancelReasons.push(reason);
            },
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ id: "primary", type: "text-start" });
              controller.enqueue({
                delta: "partial",
                id: "primary",
                type: "text-delta",
              });
            },
          }),
        }),
    });
    const attempts: Array<{ outcome: string }> = [];
    const route = createRouter({
      fallback: { health: true, retryBudget: true },
      models: {
        chat: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          streamingModel(["must not run"]),
        ],
      },
      onAttempt: ({ outcome }) => attempts.push({ outcome }),
    });
    const caller = new AbortController();
    const consumerReason = new Error("consumer cancelled first");
    const callerReason = new Error("caller stopped second");
    const result = await asV4(route("chat")).doStream({
      ...genOptions,
      abortSignal: caller.signal,
    });
    const reader = result.stream.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    const pending = reader.read();

    await reader.cancel(consumerReason);
    caller.abort(callerReason);
    await pending;

    expect(upstreamCancelReasons).toEqual([consumerReason]);
    expect(attempts).toEqual([{ outcome: "cancelled" }]);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
  });

  it("does not retry a pre-output stream error with a wrapped abort cause", async () => {
    const abort = new DOMException("caller stopped", "AbortError");
    const wrappedFailure = Object.assign(new Error("gateway stream failed"), {
      cause: abort,
    });
    const primary = errorPartStreamModel(wrappedFailure);
    const secondary = streamingModel(["must not run"]);
    const route = createRouter({
      fallback: { health: true },
      models: { chat: [primary, secondary] },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).rejects.toBe(wrappedFailure);
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
  });

  it("reads a terminal stream error code once across classification layers", async () => {
    let reads = 0;
    const failure = Object.defineProperty(
      new Error("contract failed"),
      "code",
      {
        get() {
          reads += 1;
          return "call_options_contract_error";
        },
      }
    );
    const primary = errorPartStreamModel(failure);
    const secondary = streamingModel(["must not run"]);
    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).rejects.toBe(failure);
    expect(reads).toBe(1);
    expect(secondary.doStreamCalls).toHaveLength(0);
  });

  it("evaluates a custom retry hook once for a pre-output stream failure", async () => {
    const primary = errorPartStreamModel(new Error("overloaded 503"));
    const secondary = streamingModel(["from secondary"]);
    const shouldRetry = vi.fn(() => true);
    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
      fallback: { shouldRetry },
    });

    const acc = await collectStream(
      streamText({ model: route("chat"), prompt: "hi" })
    );

    expect(acc).toBe("from secondary");
    expect(shouldRetry).toHaveBeenCalledOnce();
  });
});
