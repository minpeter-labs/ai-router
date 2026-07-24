import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { chunkModel, errorPartModel, runFallback, textModel } from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("falls back when stream-part provider metadata access throws", async () => {
    const hostileDelta = Object.defineProperty(
      { delta: "unusable", id: "1", type: "text-delta" },
      "providerMetadata",
      {
        get() {
          throw new Error("stream metadata getter failed");
        },
      }
    ) as LanguageModelV4StreamPart;
    const malformed = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      hostileDelta,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
  });

  it("falls back on cyclic stream provider JSON payloads", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const malformedParts = [
      {
        id: "1",
        providerMetadata: { mock: circular },
        type: "text-start",
      },
      {
        result: circular,
        toolCallId: "call",
        toolName: "tool",
        type: "tool-result",
      },
    ];

    for (const part of malformedParts) {
      const malformed = chunkModel([
        { type: "stream-start", warnings: [] },
        part as LanguageModelV4StreamPart,
      ]);
      const out = await runFallback([malformed, textModel(["recovered"])]);

      expect(out.error).toBeUndefined();
      expect(out.text).toBe("recovered");
    }
  });

  it("falls back on malformed response metadata fields", async () => {
    const malformedParts = [
      { id: 42, type: "response-metadata" },
      { modelId: false, type: "response-metadata" },
      { timestamp: new Date(Number.NaN), type: "response-metadata" },
      Object.defineProperty({ type: "response-metadata" }, "timestamp", {
        get() {
          throw new Error("timestamp getter failed");
        },
      }),
    ];

    for (const part of malformedParts) {
      const malformed = chunkModel([
        { type: "stream-start", warnings: [] },
        part as LanguageModelV4StreamPart,
      ]);
      const out = await runFallback([malformed, textModel(["recovered"])]);
      expect(out.error).toBeUndefined();
      expect(out.text).toBe("recovered");
    }
  });

  it("bounds oversized stream warning collections", async () => {
    const malformed = chunkModel([
      {
        type: "stream-start",
        warnings: Array.from({ length: 1025 }, () => ({
          message: "warning",
          type: "other" as const,
        })),
      },
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
  });

  it("does NOT fall back on a non-retryable pre-output error", async () => {
    const primary = errorPartModel({
      statusCode: 404,
      message: "unrelated resource not found",
    });
    const secondary = textModel(["secondary"]);

    const out = await runFallback([primary, secondary]);
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect((out.error as { statusCode?: number }).statusCode).toBe(404);
  });

  it("surfaces an AggregateError when every candidate fails mid-stream", async () => {
    const a = errorPartModel(new Error("first 503"));
    const b = errorPartModel(new Error("second 503"));
    const c = errorPartModel(new Error("last 503"));

    const out = await runFallback([a, b, c]);
    expect(out.error).toBeInstanceOf(AggregateError);
    expect((out.error as AggregateError).errors).toHaveLength(3);
    expect((out.error as AggregateError).message).toContain("last 503");
    expect((out.error as AggregateError).cause).toBe(
      (out.error as AggregateError).errors.at(-1)
    );
  });

  it("keeps stream aggregate summaries stable across error hook mutation", async () => {
    const first = new Error("first stream original");
    const last = new Error("last stream original");
    const out = await runFallback(
      [errorPartModel(first), errorPartModel(last)],
      {
        onError: ({ error }) => {
          if (error instanceof Error) {
            error.message = "mutated by stream hook";
          }
        },
      }
    );

    expect(out.error).toBeInstanceOf(AggregateError);
    expect((out.error as AggregateError).message).toContain(
      "last stream original"
    );
    expect((out.error as AggregateError).message).not.toContain(
      "mutated by stream hook"
    );
    expect((out.error as AggregateError).cause).toBe(last);
  });

  it("surfaces an AggregateError including prior retryable errors when a later candidate fails non-retryably", async () => {
    // A and B fail with retryable 503s (each triggers fallback and accumulates),
    // then C emits a non-retryable 400. The consumer must see all three errors,
    // not just C's 400 — matching the README's all-candidates-failed contract.
    const a = errorPartModel(new Error("first 503"));
    const b = errorPartModel(new Error("second 503"));
    const c = errorPartModel({ statusCode: 400, message: "bad request" });

    const out = await runFallback([a, b, c]);
    expect(out.error).toBeInstanceOf(AggregateError);
    expect((out.error as AggregateError).errors).toHaveLength(3);
    expect(a.doStreamCalls).toHaveLength(1);
    expect(b.doStreamCalls).toHaveLength(1);
    expect(c.doStreamCalls).toHaveLength(1);
  });

  it("falls back on a pre-content error that arrives AFTER framing parts (response-metadata/text-start)", async () => {
    // The openai-compatible provider emits response-metadata (and text-start) on
    // its first chunk before any text-delta. An error there is still pre-content.
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
    const secondary = textModel(["from secondary"]);

    const out = await runFallback([primary, secondary]);
    expect(out.text).toBe("from secondary");
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(out.parts.some((p) => p.type === "error")).toBe(false);
  });

  it("emits exactly one stream-start after a pre-content fallback", async () => {
    const out = await runFallback([
      errorPartModel(new Error("503")),
      textModel(["ok"]),
    ]);
    expect(out.parts.filter((p) => p.type === "stream-start")).toHaveLength(1);
  });
});
