import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  chunkModel,
  finishReason,
  lazyChunkModel,
  runFallback,
  textModel,
  usage,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("consumes rejected async siblings across a malformed finish part", async () => {
    const rejected = (label: string) => Promise.reject(new Error(label));
    const malformed = lazyChunkModel([
      () => ({ type: "stream-start", warnings: [] }),
      () =>
        ({
          finishReason: {
            raw: rejected("async raw finish reason"),
            unified: rejected("async unified finish reason"),
          },
          providerMetadata: rejected("async finish provider metadata"),
          type: "finish",
          usage: {
            inputTokens: {
              cacheRead: rejected("async cache read"),
              cacheWrite: rejected("async cache write"),
              noCache: 10,
              total: 10,
            },
            outputTokens: {
              reasoning: rejected("async reasoning tokens"),
              text: rejected("async text tokens"),
              total: 20,
            },
            raw: {
              first: rejected("async raw usage first"),
              second: rejected("async raw usage second"),
            },
          },
        }) as never,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("falls back on malformed stream warnings", async () => {
    for (const warnings of [
      [{ type: "other" }],
      [{ message: "x".repeat(65_537), type: "other" }],
      Array.from({ length: 17 }, () => ({
        message: "x".repeat(65_536),
        type: "other" as const,
      })),
      new Array(1),
      new Array(1_000_000),
    ]) {
      const malformed = chunkModel([
        { type: "stream-start", warnings } as never,
      ]);

      const out = await runFallback([malformed, textModel(["recovered"])]);
      expect(out.error).toBeUndefined();
      expect(out.text).toBe("recovered");
    }
  });

  it("consumes every rejected async stream warning sibling", async () => {
    const malformed = lazyChunkModel([
      () =>
        ({
          type: "stream-start",
          warnings: [
            {
              details: Promise.reject(new Error("async warning details")),
              feature: Promise.reject(new Error("async warning feature")),
              type: "unsupported",
            },
            Promise.reject(new Error("async warning entry")),
          ],
        }) as never,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("falls back on malformed known stream part fields", async () => {
    const malformedStreams = [
      chunkModel([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: 42 } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "" },
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "x".repeat(4097) },
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        { type: "" } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        { type: "x".repeat(257) } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        { type: 42 } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        {
          data: {},
          mediaType: "image/png",
          type: "file",
        } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        { kind: "invalid", type: "custom" } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        {
          id: "tool",
          providerExecuted: "yes",
          toolName: "tool",
          type: "tool-input-start",
        } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        {
          id: "source",
          providerMetadata: "invalid",
          sourceType: "url",
          title: 42,
          type: "source",
          url: "https://example.com",
        } as never,
      ]),
    ];

    for (const malformed of malformedStreams) {
      const out = await runFallback([malformed, textModel(["recovered"])]);
      expect(out.error).toBeUndefined();
      expect(out.text).toBe("recovered");
    }
  });

  it("does not read fields from the inactive stream source variant", async () => {
    let inactiveReads = 0;
    const source = Object.defineProperties(
      {
        id: "source",
        sourceType: "url",
        title: "Example",
        type: "source",
        url: "https://example.com/source",
      },
      {
        filename: {
          get() {
            inactiveReads += 1;
            throw new Error("inactive filename must not be read");
          },
        },
        mediaType: {
          get() {
            inactiveReads += 1;
            throw new Error("inactive media type must not be read");
          },
        },
      }
    ) as LanguageModelV4StreamPart;
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      source,
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);

    expect(out.error).toBeUndefined();
    expect(out.parts).toContainEqual(source);
    expect(inactiveReads).toBe(0);
  });
});
