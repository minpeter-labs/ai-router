import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import { type FallbackStreamArgs, wrapStreamResult } from "../stream";
import {
  callOptions,
  chunkModel,
  errorPartModel,
  finishReason,
  resolved,
  runFallback,
  textModel,
  transportRejectModel,
  usage,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it.each([
    ["attemptsStarted", 0],
    ["attemptTimeout", Number.NaN],
    ["backoff", 0],
    ["budgetFailureObserved", "yes"],
    ["firstContentTimeout", 86_400_001],
    ["logicalId", ""],
    ["maxAttempts", 1.5],
    ["options", null],
    ["retryAfterOutput", "yes"],
    ["startIndex", 1],
    ["startInFlight", 0],
    ["strictStreamValidation", "yes"],
    ["totalDeadline", Number.POSITIVE_INFINITY],
    ["totalTimeout", -1],
  ])("rejects malformed stream setup scalar %s", (key, value) => {
    let upstreamCancelled = 0;
    const releases: string[] = [];
    const model = textModel(["must not run"]);
    const args: FallbackStreamArgs = {
      candidates: [resolved(model, 0)],
      firstResult: {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            upstreamCancelled += 1;
          },
        }),
      },
      logicalId: "chat",
      options: callOptions,
      releaseCandidate: () => releases.push("capacity"),
      releaseProbeCandidate: () => releases.push("probe"),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };
    Reflect.set(args, key, value);

    expect(() => wrapStreamResult(args)).toThrow(
      expect.objectContaining({ code: "stream_unavailable" })
    );
    expect(upstreamCancelled).toBe(1);
    expect(releases).toEqual(["capacity", "probe"]);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("falls back on a PRE-output in-band error part, swallowing the error", async () => {
    const primary = errorPartModel(new Error("overloaded 503"));
    const secondary = textModel(["from ", "secondary"]);
    const seen: Array<{ index: number; phase?: string; willRetry?: boolean }> =
      [];

    const out = await runFallback([primary, secondary], {
      onError: (info) =>
        seen.push({
          index: info.index,
          phase: info.phase,
          willRetry: info.willRetry,
        }),
    });

    expect(out.text).toBe("from secondary");
    // The failed candidate's terminal error part was swallowed, not forwarded.
    expect(out.parts.some((p) => p.type === "error")).toBe(false);
    expect(out.error).toBeUndefined();
    expect(seen).toEqual([{ index: 0, phase: "stream-open", willRetry: true }]);
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(secondary.doStreamCalls).toHaveLength(1);
  });

  it("does NOT fall back after content streamed (retryAfterOutput=false) — no double-emit", async () => {
    const primary = errorPartModel(new Error("503"), ["partial answer"]);
    const secondary = textModel(["SHOULD NOT APPEAR"]);

    const out = await runFallback([primary, secondary], {
      retryAfterOutput: false,
    });

    // 'partial answer' appears exactly once; the secondary is never consulted.
    expect(out.text).toBe("partial answer");
    expect(secondary.doStreamCalls).toHaveLength(0);
    // The terminal error part is forwarded verbatim (cannot un-ring the bell).
    expect(out.parts.some((p) => p.type === "error")).toBe(true);
  });

  it("DOES fall back after content when retryAfterOutput=true (may duplicate)", async () => {
    const primary = errorPartModel(new Error("503"), ["partial "]);
    const secondary = textModel(["secondary"]);

    const out = await runFallback([primary, secondary], {
      retryAfterOutput: true,
    });

    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(out.text).toContain("partial ");
    expect(out.text).toContain("secondary");
  });

  it("restarts first-content validation for each post-output fallback", async () => {
    const hangingAfterFraming = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "middle" });
            },
          }),
        }),
    });
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed"), ["partial "]),
        hangingAfterFraming,
        textModel(["recovered"]),
      ],
      { firstContentTimeout: 10, retryAfterOutput: true }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("partial recovered");
    expect(
      out.parts.filter((part) => part.type === "stream-start")
    ).toHaveLength(2);
  });

  it("cancels a timed-out pending read and releases its reader lock once", async () => {
    let cancelCalls = 0;
    let releaseCalls = 0;
    const reader = {
      cancel() {
        cancelCalls += 1;
        return Promise.resolve();
      },
      read: () => new Promise<never>(() => undefined),
      releaseLock() {
        releaseCalls += 1;
      },
    };
    const hanging = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: { getReader: () => reader },
        }) as never,
    });

    const out = await runFallback([hanging, textModel(["recovered"])], {
      firstContentTimeout: 10,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(cancelCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it("treats a rejected read (transport drop) like an error and falls back", async () => {
    const primary = transportRejectModel(new Error("transport drop 503"));
    const secondary = textModel(["recovered"]);

    const out = await runFallback([primary, secondary]);
    expect(out.text).toBe("recovered");
    expect(out.error).toBeUndefined();
  });

  it("rejects malformed finish metadata using post-output retry policy", async () => {
    const malformed = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "partial" },
      { type: "text-end", id: "1" },
      {
        type: "finish",
        finishReason,
        usage: {
          ...usage,
          outputTokens: { ...usage.outputTokens, total: Number.NaN },
        },
      },
    ]);
    const stopped = await runFallback([malformed, textModel(["unused"])]);
    expect(stopped.error).toMatchObject({ code: "invalid_model_stream" });

    const retried = await runFallback([malformed, textModel(["recovered"])], {
      retryAfterOutput: true,
    });
    expect(retried.error).toBeUndefined();
    expect(retried.text).toBe("partialrecovered");
  });

  it("falls back when finish metadata getters throw", async () => {
    const hostileFinish = Object.defineProperty(
      { type: "finish", usage },
      "finishReason",
      {
        get() {
          throw new Error("finish getter failed");
        },
      }
    ) as LanguageModelV4StreamPart;
    const malformed = chunkModel([
      { type: "stream-start", warnings: [] },
      hostileFinish,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
  });
});
