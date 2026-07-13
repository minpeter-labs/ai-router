import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  errorPartModel,
  finishReason,
  runFallback,
  textModel,
  usage,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("closes downstream when finish arrives even if upstream never closes", async () => {
    let cancelled = false;
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "1" });
            controller.enqueue({ type: "text-delta", id: "1", delta: "done" });
            controller.enqueue({ type: "text-end", id: "1" });
            controller.enqueue({ type: "finish", finishReason, usage });
          },
          cancel() {
            cancelled = true;
          },
        }),
      }),
    });

    const out = await runFallback([primary]);
    expect(out.text).toBe("done");
    expect(cancelled).toBe(true);
  });

  it("reports phase stream-mid for a post-content failure when retryAfterOutput=true", async () => {
    const primary = errorPartModel(new Error("503"), ["partial "]);
    const secondary = textModel(["secondary"]);
    const seen: Array<{ phase?: string; willRetry?: boolean }> = [];

    await runFallback([primary, secondary], {
      retryAfterOutput: true,
      onError: (info) =>
        seen.push({ phase: info.phase, willRetry: info.willRetry }),
    });

    expect(seen).toContainEqual({ phase: "stream-mid", willRetry: true });
  });
});
