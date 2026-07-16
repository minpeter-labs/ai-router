import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  chunkModel,
  finishReason,
  runFallback,
  textModel,
  usage,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("does not leak the failed candidate framing parts (no duplicate response-metadata/text-start)", async () => {
    // Primary forwards a full framing prelude then fails pre-content; none of it
    // must reach the consumer — only the survivor's single clean lifecycle.
    const primary = chunkModel([
      { type: "stream-start", warnings: [] },
      {
        type: "response-metadata",
        id: "res-1",
        modelId: "m",
        timestamp: new Date(0),
      },
      { type: "text-start", id: "1" },
      { type: "error", error: new Error("overloaded 503") },
    ]);
    const secondary = chunkModel([
      { type: "stream-start", warnings: [] },
      {
        type: "response-metadata",
        id: "res-2",
        modelId: "m",
        timestamp: new Date(0),
      },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "ok" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([primary, secondary]);
    expect(out.text).toBe("ok");
    expect(out.parts.filter((p) => p.type === "stream-start")).toHaveLength(1);
    expect(
      out.parts.filter((p) => p.type === "response-metadata")
    ).toHaveLength(1);
    expect(out.parts.filter((p) => p.type === "text-start")).toHaveLength(1);
  });

  it("forwards only the survivor's warnings and raw prelude", async () => {
    const failed = chunkModel([
      {
        type: "stream-start",
        warnings: [{ type: "other", message: "failed warning" }],
      },
      { type: "raw", rawValue: "failed raw" },
      { type: "error", error: new Error("failed") },
    ]);
    const survivor = chunkModel([
      {
        type: "stream-start",
        warnings: [{ type: "other", message: "survivor warning" }],
      },
      { type: "raw", rawValue: "survivor raw" },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "ok" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([failed, survivor]);
    const starts = out.parts.filter((part) => part.type === "stream-start");
    const raws = out.parts.filter((part) => part.type === "raw");
    expect(starts).toEqual([
      {
        type: "stream-start",
        warnings: [{ type: "other", message: "survivor warning" }],
      },
    ]);
    expect(raws).toEqual([{ type: "raw", rawValue: "survivor raw" }]);
  });

  it("snapshots ordinary raw JSON and recognized mutable raw values", async () => {
    const rawJson = { nested: { value: "before" } };
    const opaque = new Uint8Array([1, 2, 3]);
    const rawUrl = new URL("https://example.com/raw");
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "raw", rawValue: rawJson },
      { type: "raw", rawValue: opaque },
      { type: "raw", rawValue: rawUrl },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "ok" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);
    rawJson.nested.value = "after";
    opaque[0] = 9;
    rawUrl.pathname = "/mutated";
    const raws = out.parts.filter((part) => part.type === "raw");

    expect(raws[0]).toEqual({
      type: "raw",
      rawValue: { nested: { value: "before" } },
    });
    expect(raws[0]?.rawValue).not.toBe(rawJson);
    expect(raws[1]?.rawValue).not.toBe(opaque);
    expect([...(raws[1]?.rawValue as Uint8Array)]).toEqual([1, 2, 3]);
    expect(raws[2]?.rawValue).not.toBe(rawUrl);
    expect(URL.prototype.toString.call(raws[2]?.rawValue)).toBe(
      "https://example.com/raw"
    );
  });

  it("bounds aggregate JSON retained by raw stream parts", async () => {
    const excessive = chunkModel([
      { type: "stream-start", warnings: [] },
      ...Array.from({ length: 6 }, () => ({
        type: "raw" as const,
        rawValue: { items: Array.from({ length: 9000 }, () => ({})) },
      })),
    ]);
    const fallback = textModel(["recovered"]);

    const out = await runFallback([excessive, fallback]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(out.parts.some((part) => part.type === "raw")).toBe(false);
  });

  it("rolls back discarded pre-commit JSON budget before fallback", async () => {
    const failed = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "raw", rawValue: { payload: "x".repeat(3_500_000) } },
      { type: "error", error: new Error("retryable") },
    ]);
    const survivor = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "raw", rawValue: { payload: "y".repeat(1_000_000) } },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "recovered" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([failed, survivor]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(out.parts.filter((part) => part.type === "raw")).toHaveLength(1);
  });

  it("rolls back discarded pre-commit metadata characters", async () => {
    const largeTitle = "x".repeat(65_000);
    const failed = chunkModel([
      { type: "stream-start", warnings: [] },
      ...Array.from({ length: 64 }, (_, index) => ({
        id: `call-${index}`,
        title: largeTitle,
        toolName: "tool",
        type: "tool-input-start" as const,
      })),
      { type: "error", error: new Error("retryable") },
    ]);
    const survivor = chunkModel([
      { type: "stream-start", warnings: [] },
      {
        id: "survivor-call",
        title: largeTitle,
        toolName: "tool",
        type: "tool-input-start",
      },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "recovered" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([failed, survivor]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
  });

  it("does NOT fall back after a clean finish even if the transport then drops", async () => {
    // A completed stream (finish emitted) followed by a read rejection is just the
    // connection closing — the request already succeeded; do not re-run it.
    const primary = new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock",
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "1" });
            controller.enqueue({
              type: "text-delta",
              id: "1",
              delta: "done",
            });
            controller.enqueue({ type: "text-end", id: "1" });
            controller.enqueue({ type: "finish", finishReason, usage });
          },
          pull() {
            throw new Error("ECONNRESET");
          },
        }),
      }),
    });
    const secondary = textModel(["SHOULD NOT RUN"]);
    const outcomes: Array<readonly [boolean, boolean, boolean]> = [];

    const out = await runFallback([primary, secondary], {
      onRequestOutcome: (...outcome) => outcomes.push(outcome),
    });
    expect(out.error).toBeUndefined();
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect(out.parts.filter((p) => p.type === "finish")).toHaveLength(1);
    expect(outcomes).toEqual([[true, false, false]]);
  });
});
