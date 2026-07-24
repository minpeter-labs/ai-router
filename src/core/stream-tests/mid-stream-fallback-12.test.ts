import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import { wrapStreamResult } from "../stream";
import {
  callOptions,
  chunkModel,
  drive,
  errorPartModel,
  finishReason,
  resolved,
  runFallback,
  textModel,
  usage,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("isolates admission wait hook candidate mutation", async () => {
    const releases: number[] = [];
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["recovered"]);
    const firstResult = await primary.doStream(callOptions);
    const wrapped = wrapStreamResult({
      acquireCandidate: () => undefined,
      candidates: [resolved(primary, 0), resolved(survivor, 1)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      releaseCandidate: (candidate) => releases.push(candidate.fullIndex),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
      waitForCandidate: (candidate) => {
        expect(candidate.fullIndex).toBe(1);
        candidate.fullIndex = 100;
        return Promise.resolve(1);
      },
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({
      text: "recovered",
    });
    expect(releases).toEqual([0, 1]);
  });

  it("does not replace a provider failure with a hostile aborted getter", async () => {
    const first = new Error("retry this provider failure");
    let abortReads = 0;
    const signal = {
      addEventListener() {
        // The synthetic signal remains active.
      },
      get aborted() {
        abortReads += 1;
        if (abortReads >= 3) {
          throw new Error("aborted getter unavailable");
        }
        return false;
      },
      removeEventListener() {
        // The synthetic signal does not retain listeners.
      },
    } as unknown as AbortSignal;

    const out = await runFallback(
      [errorPartModel(first), textModel(["fallback"])],
      {
        abortSignal: signal,
        classifyFailure: (error) => ({
          retryable: error === first,
          scope: "transient",
        }),
      }
    );

    expect(out.text).toBe("fallback");
    expect(out.error).toBeUndefined();
    expect(abortReads).toBeGreaterThanOrEqual(3);
  });

  it("reports a post-output in-band error through onError", async () => {
    const failure = new Error("connection dropped");
    const seen: unknown[] = [];
    await runFallback([errorPartModel(failure, ["partial"])], {
      onError: ({ error }) => seen.push(error),
    });

    expect(seen).toEqual([failure]);
  });

  it("releases admission after a post-output in-band error", async () => {
    const released: number[] = [];
    await runFallback([errorPartModel(new Error("dropped"), ["partial"])], {
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
    });

    expect(released).toEqual([0]);
  });

  it("cancels a failed upstream before opening its fallback", async () => {
    let cancelled = false;
    const failed = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "error", error: new Error("failed") });
          },
          cancel() {
            cancelled = true;
          },
        }),
      }),
    });

    const out = await runFallback([failed, textModel(["fallback"])]);
    expect(out.text).toBe("fallback");
    expect(cancelled).toBe(true);
  });

  it("falls back on an invalid block lifecycle in strict mode", async () => {
    const invalid = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-delta", id: "missing", delta: "bad" },
    ]);
    const out = await runFallback([invalid, textModel(["valid"])], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("valid");
  });

  it("requires a final tool-call after streamed tool input in strict mode", async () => {
    const incompleteTool = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "call-1", toolName: "search" },
      { type: "tool-input-delta", id: "call-1", delta: '{"q":"x"}' },
      { type: "tool-input-end", id: "call-1" },
      { type: "finish", finishReason, usage },
    ]);
    const out = await runFallback([incompleteTool, textModel(["valid"])], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("valid");
  });

  it("bounds buffered strict tool-input text before output", async () => {
    const oversizedTool = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "call-1", toolName: "search" },
      { type: "tool-input-delta", id: "call-1", delta: "x".repeat(1_048_577) },
    ]);
    const out = await runFallback([oversizedTool, textModel(["valid"])], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("valid");
  });

  it("accepts a complete streamed tool call in strict mode", async () => {
    const completeTool = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "call-1", toolName: "search" },
      { type: "tool-input-delta", id: "call-1", delta: '{"q":"x"}' },
      { type: "tool-input-end", id: "call-1" },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "search",
        input: '{"q":"x"}',
      },
      { type: "finish", finishReason, usage },
    ]);
    const out = await runFallback([completeTool], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.parts.some((part) => part.type === "tool-call")).toBe(true);
  });

  it("bounds strict tool-call tracking after output commits", async () => {
    const excessive = chunkModel([
      { type: "stream-start", warnings: [] },
      ...Array.from({ length: 1025 }, (_, index) => ({
        input: "{}",
        toolCallId: `call-${index}`,
        toolName: "search",
        type: "tool-call" as const,
      })),
    ]);
    const fallback = textModel(["must not run"]);

    const out = await runFallback([excessive, fallback], {
      strictStreamValidation: true,
    });

    expect(out.error).toMatchObject({ code: "invalid_model_stream" });
    expect(out.parts.filter((part) => part.type === "tool-call")).toHaveLength(
      1024
    );
    expect(fallback.doStreamCalls).toHaveLength(0);
  });
});
