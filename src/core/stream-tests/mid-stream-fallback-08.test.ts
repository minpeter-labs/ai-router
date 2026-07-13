import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import { wrapStreamResult } from "../stream";
import {
  callOptions,
  drive,
  errorPartModel,
  finishReason,
  resolved,
  runFallback,
  textModel,
  usage,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("captures a repeatedly delivered stream abort reason once", async () => {
    let reasonReads = 0;
    let removals = 0;
    const reason = new Error("stream stopped repeatedly");
    const signal = {
      aborted: false,
      addEventListener(_name: string, listener: () => void) {
        listener();
        listener();
      },
      get reason() {
        reasonReads += 1;
        return reason;
      },
      removeEventListener() {
        removals += 1;
      },
    } as unknown as AbortSignal;

    const out = await runFallback([textModel(["must not emit"])], {
      abortSignal: signal,
    });
    expect(out.error).toBe(reason);
    expect(reasonReads).toBe(1);
    expect(removals).toBe(1);
  });

  it("routes stream-listener registration failure through cleanup", async () => {
    const failure = new Error("stream listener unavailable");
    const signal = {
      aborted: false,
      addEventListener() {
        throw failure;
      },
      removeEventListener() {
        throw new Error("stream listener cleanup unavailable");
      },
    } as unknown as AbortSignal;
    const released: number[] = [];

    const out = await runFallback([textModel(["must not emit"])], {
      abortSignal: signal,
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
    });
    expect(out.error).toBe(failure);
    expect(out.text).toBe("");
    expect(released).toEqual([0]);
  });

  it("preserves delivered stream abort when registration then throws", async () => {
    const reason = new Error("stream aborted during failed registration");
    let aborted = false;
    const signal = {
      addEventListener(_name: string, listener: () => void) {
        aborted = true;
        listener();
        throw new Error("stream listener registration failed");
      },
      get aborted() {
        return aborted;
      },
      reason,
      removeEventListener() {
        // Registration rollback has no retained listener.
      },
    } as unknown as AbortSignal;
    const released: number[] = [];

    const out = await runFallback([textModel(["must not emit"])], {
      abortSignal: signal,
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
    });
    expect(out.error).toBe(reason);
    expect(out.text).toBe("");
    expect(released).toEqual([0]);
  });

  it("preserves caller abort identity after an earlier stream failure", async () => {
    const hanging = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>(),
      }),
    });
    const controller = new AbortController();
    const pending = runFallback(
      [errorPartModel(new Error("primary failed")), hanging],
      { abortSignal: controller.signal }
    );
    while (hanging.doStreamCalls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const reason = new Error("caller stopped stream fallback");

    controller.abort(reason);

    const result = await pending;
    expect(result.error).toBe(reason);
  });

  it("stops reading upstream while the downstream queue is backpressured", async () => {
    const chunks: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      ...Array.from({ length: 20 }, (_, index) => ({
        type: "text-delta" as const,
        id: "1",
        delta: String(index),
      })),
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ];
    let pulls = 0;
    let position = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          pull(controller) {
            pulls += 1;
            const chunk = chunks[position];
            position += 1;
            if (chunk === undefined) {
              controller.close();
            } else {
              controller.enqueue(chunk);
            }
          },
        }),
      }),
    });
    const candidates = [resolved(model)];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pulls).toBeLessThan(chunks.length);

    const out = await drive(wrapped.stream);
    expect(out.text).toBe(
      Array.from({ length: 20 }, (_, i) => String(i)).join("")
    );
  });

  it("unblocks a backpressured pump and releases resources on consumer cancel", async () => {
    let upstreamCancelled = false;
    const released: number[] = [];
    const attempts: Array<{
      attempt?: number;
      inFlight?: number;
      limit?: number;
      outcome: string;
    }> = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "1" });
            controller.enqueue({ type: "text-delta", id: "1", delta: "one" });
            controller.enqueue({ type: "text-delta", id: "1", delta: "two" });
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
      }),
    });
    const candidates = [resolved(model)];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      concurrencyLimit: () => 2,
      options: callOptions,
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
      onAttempt: ({ attempt, concurrencyLimit, inFlight, outcome }) =>
        attempts.push({
          attempt,
          inFlight,
          limit: concurrencyLimit,
          outcome,
        }),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
      startInFlight: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapped.stream.cancel("consumer stopped");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upstreamCancelled).toBe(true);
    expect(released).toEqual([0]);
    expect(attempts).toEqual([
      { attempt: 1, inFlight: 1, limit: 2, outcome: "cancelled" },
    ]);
  });
});
