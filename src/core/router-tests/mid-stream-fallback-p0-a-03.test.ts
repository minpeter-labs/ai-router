import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import { asV4, collectStream, genOptions, streamingModel } from "./test-kit";

describe("createRouter — mid-stream fallback (P0-A)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps caller abort request-scoped when it triggers a read rejection", async () => {
    const providerFailure = Object.assign(new Error("abort-side 429"), {
      responseHeaders: { "x-ratelimit-reset-tokens": "120s" },
      statusCode: 429,
    });
    let readWaiting: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      readWaiting = resolve;
    });
    const primary = new MockLanguageModelV4({
      doStream: (options) => {
        let step = 0;
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
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
                options.abortSignal?.addEventListener(
                  "abort",
                  () => controller.error(providerFailure),
                  { once: true }
                );
              }
              step += 1;
            },
          }),
        });
      },
    });
    const fallback = streamingModel(["must not run"]);
    const attempts: Array<{ outcome: string }> = [];
    const route = createRouter({
      fallback: {
        health: true,
        retryAfterOutput: true,
        retryBudget: true,
      },
      models: {
        chat: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          fallback,
        ],
      },
      onAttempt: ({ outcome }) => attempts.push({ outcome }),
    });
    const caller = new AbortController();
    const reason = new Error("caller stopped pending read");
    const result = collectStream(
      streamText({
        abortSignal: caller.signal,
        model: route("chat"),
        prompt: "abort race",
      })
    );
    await waiting;

    caller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
    expect(attempts).toEqual([]);
  });

  it("keeps caller abort request-scoped when it triggers an error part", async () => {
    const providerFailure = Object.assign(new Error("abort-side error 429"), {
      responseHeaders: { "x-ratelimit-reset-tokens": "120s" },
      statusCode: 429,
    });
    let errorPartWaiting: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      errorPartWaiting = resolve;
    });
    const primary = new MockLanguageModelV4({
      doStream: (options) => {
        let step = 0;
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
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
                errorPartWaiting?.();
                options.abortSignal?.addEventListener(
                  "abort",
                  () => {
                    controller.enqueue({
                      error: providerFailure,
                      type: "error",
                    });
                    controller.close();
                  },
                  { once: true }
                );
              }
              step += 1;
            },
          }),
        });
      },
    });
    const fallback = streamingModel(["must not run"]);
    const attempts: Array<{ outcome: string }> = [];
    const route = createRouter({
      fallback: { health: true, retryBudget: true },
      models: {
        chat: [
          { healthKey: "shared-key", maxConcurrency: 1, model: primary },
          fallback,
        ],
      },
      onAttempt: ({ outcome }) => attempts.push({ outcome }),
    });
    const listeners = new Set<() => void>();
    const capturedReason = new Error("caller stopped pending error part");
    const mutatedReason = new Error("mutated caller reason");
    let aborted = false;
    let reasonReads = 0;
    const callerSignal = {
      addEventListener(_name: string, listener: () => void) {
        listeners.add(listener);
      },
      get aborted() {
        return aborted;
      },
      get reason() {
        reasonReads += 1;
        return reasonReads === 1 ? capturedReason : mutatedReason;
      },
      removeEventListener(_name: string, listener: () => void) {
        listeners.delete(listener);
      },
    } as unknown as AbortSignal;
    const result = await asV4(route("chat")).doStream({
      ...genOptions,
      abortSignal: callerSignal,
    });
    const reader = result.stream.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    const pending = reader.read();
    await waiting;

    aborted = true;
    for (const listener of [...listeners]) {
      listener();
    }

    await expect(pending).rejects.toBe(capturedReason);
    expect(reasonReads).toBe(1);
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
    expect(attempts).toEqual([]);
  });
});
