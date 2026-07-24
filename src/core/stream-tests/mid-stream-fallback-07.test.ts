import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import { wrapStreamResult } from "../stream";
import {
  callOptions,
  drive,
  errorPartModel,
  resolved,
  runFallback,
  textModel,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("drops stream response-header values containing control characters", async () => {
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    firstResult.response = {
      headers: {
        "x-later": Promise.reject(new Error("async malformed-value sibling")),
        "x-value": "safe\r\ninjected",
      },
    } as never;
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("drops stream response headers above the aggregate size limit", async () => {
    const model = textModel(["ok"]);
    const candidates = [resolved(model)];
    const firstResult = await model.doStream(callOptions);
    firstResult.response = {
      headers: Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [
          `x-large-${index}`,
          "x".repeat(65_536),
        ])
      ),
    };
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.response).toBeUndefined();
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
  });

  it("updates live request and response metadata to the fallback survivor", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["ok"]);
    const candidates = [resolved(primary), resolved(survivor, 1)];
    const firstResult = await primary.doStream(callOptions);
    firstResult.request = { body: "primary request" };
    firstResult.response = { headers: { "x-provider": "primary" } };
    survivor.doStream = async (options) => {
      const result = await textModel(["ok"]).doStream(options);
      return {
        ...result,
        request: { body: "survivor request" },
        response: { headers: { "x-provider": "survivor" } },
      };
    };
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    expect(wrapped.request).toEqual({ body: "primary request" });
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(wrapped.request).toEqual({ body: "survivor request" });
    expect(wrapped.response).toEqual({
      headers: { "x-provider": "survivor" },
    });
  });

  it("does not activate metadata from a fallback with a malformed reader", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const malformed = new MockLanguageModelV4({
      doStream: async () =>
        ({
          request: { body: "malformed request" },
          response: { headers: { "x-provider": "malformed" } },
          stream: {
            getReader() {
              observedDuringReaderValidation = wrapped.request;
              throw new Error("reader unavailable");
            },
          },
        }) as never,
    });
    const survivor = textModel(["ok"]);
    const candidates = [
      resolved(primary),
      resolved(malformed, 1),
      resolved(survivor, 2),
    ];
    const firstResult = await primary.doStream(callOptions);
    firstResult.request = { body: "primary request" };
    let observedDuringReaderValidation: unknown;
    let wrapped: ReturnType<typeof wrapStreamResult>;
    wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(observedDuringReaderValidation).toEqual({ body: "primary request" });
    expect(wrapped.request).not.toEqual({ body: "malformed request" });
  });

  it("includes initial stream opening time in attempt duration", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      vi.setSystemTime(100);
      const durations: number[] = [];
      await runFallback([textModel(["ok"])], {
        onAttempt: ({ durationMs, outcome }) => {
          if (outcome === "success") {
            durations.push(durationMs);
          }
        },
        startAttemptStartedAt: performance.now() - 60,
      });

      expect(durations).toEqual([60]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps attempt duration stable after wall-clock rollback", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      vi.setSystemTime(100);
      const durations: number[] = [];
      const startedAt = performance.now();
      vi.setSystemTime(0);
      await runFallback([textModel(["ok"])], {
        onAttempt: ({ durationMs, outcome }) => {
          if (outcome === "success") {
            durations.push(durationMs);
          }
        },
        startAttemptStartedAt: startedAt,
      });
      expect(durations).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a hanging open stream when the caller aborts", async () => {
    let cancelled = false;
    const hanging = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            cancel() {
              cancelled = true;
            },
          }),
        }),
    });
    const controller = new AbortController();
    const result = runFallback([hanging], { abortSignal: controller.signal });

    controller.abort(new Error("caller stopped stream"));

    await expect(result).resolves.toMatchObject({
      error: expect.objectContaining({ message: "caller stopped stream" }),
    });
    expect(cancelled).toBe(true);
  });

  it("does not miss an abort during stream-listener registration", async () => {
    const reason = new Error("stream aborted while subscribing");
    let aborted = false;
    const signal = {
      addEventListener() {
        aborted = true;
      },
      get aborted() {
        return aborted;
      },
      reason,
      removeEventListener() {
        // The synthetic signal does not retain listeners.
      },
    } as unknown as AbortSignal;

    const out = await runFallback([textModel(["must not emit"])], {
      abortSignal: signal,
    });
    expect(out.error).toBe(reason);
    expect(out.text).toBe("");
  });
});
