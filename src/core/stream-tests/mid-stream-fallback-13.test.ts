import { describe, expect, it } from "vitest";
import {
  chunkModel,
  errorPartModel,
  finishReason,
  runFallback,
  textModel,
  usage,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("bounds aggregate JSON containers across a committed stream", async () => {
    const excessiveModel = () =>
      chunkModel([
        { type: "stream-start", warnings: [] },
        ...Array.from({ length: 6 }, (_, index) => ({
          input: "{}",
          providerMetadata: {
            mock: { items: Array.from({ length: 9000 }, () => ({})) },
          },
          toolCallId: `call-${index}`,
          toolName: "search",
          type: "tool-call" as const,
        })),
      ]);

    const fallback = textModel(["must not run"]);
    const stopped = await runFallback([excessiveModel(), fallback]);
    expect(stopped.error).toMatchObject({ code: "invalid_model_stream" });
    expect(
      stopped.parts.filter((part) => part.type === "tool-call")
    ).toHaveLength(5);
    expect(fallback.doStreamCalls).toHaveLength(0);

    const retried = await runFallback(
      [excessiveModel(), textModel(["recovered"])],
      { retryAfterOutput: true }
    );
    expect(retried.error).toBeUndefined();
    expect(retried.text).toBe("recovered");
  });

  it("bounds aggregate JSON string and key characters across a stream", async () => {
    const payload = "x".repeat(1_000_000);
    const excessive = chunkModel([
      { type: "stream-start", warnings: [] },
      ...Array.from({ length: 5 }, (_, index) => ({
        input: "{}",
        providerMetadata: { mock: { payload } },
        toolCallId: `call-${index}`,
        toolName: "search",
        type: "tool-call" as const,
      })),
    ]);
    const fallback = textModel(["must not run"]);

    const out = await runFallback([excessive, fallback]);

    expect(out.error).toMatchObject({ code: "invalid_model_stream" });
    expect(out.parts.filter((part) => part.type === "tool-call")).toHaveLength(
      4
    );
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it("bounds stream metadata while leaving model body text unrestricted", async () => {
    const body = "x".repeat(100_000);
    const valid = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", delta: body, id: "1" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);
    const validOut = await runFallback([valid]);
    expect(validOut.error).toBeUndefined();
    expect(validOut.text).toBe(body);

    const title = "t".repeat(65_536);
    const excessive = chunkModel([
      { type: "stream-start", warnings: [] },
      ...Array.from({ length: 65 }, (_, index) => ({
        id: `source-${index}`,
        sourceType: "url" as const,
        title,
        type: "source" as const,
        url: "https://example.com/source",
      })),
    ]);
    const fallback = textModel(["must not run"]);

    const out = await runFallback([excessive, fallback]);

    expect(out.error).toMatchObject({ code: "invalid_model_stream" });
    expect(
      out.parts.filter((part) => part.type === "source").length
    ).toBeLessThan(65);
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it("allows empty optional streamed metadata strings", async () => {
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      {
        id: "source",
        sourceType: "url",
        title: "",
        type: "source",
        url: "https://example.com/source",
      },
      {
        finishReason: { raw: "", unified: "stop" },
        type: "finish",
        usage,
      },
    ]);

    const out = await runFallback([model]);

    expect(out.error).toBeUndefined();
    expect(out.parts.some((part) => part.type === "source")).toBe(true);
  });

  it("rejects duplicate stream-start parts in strict mode", async () => {
    const duplicateStart = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "bad" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);
    const out = await runFallback([duplicateStart, textModel(["valid"])], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("valid");
  });

  it("requires stream-start before content in strict mode", async () => {
    const missingStart = chunkModel([
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "bad" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);
    const out = await runFallback([missingStart, textModel(["valid"])], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("valid");
  });

  it("rejects duplicate response metadata in strict mode", async () => {
    const duplicateMetadata = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "one" },
      { type: "response-metadata", id: "two" },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "bad" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);
    const out = await runFallback([duplicateMetadata, textModel(["valid"])], {
      strictStreamValidation: true,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("valid");
  });

  it("reports willRetry false when concurrency admission fails", async () => {
    const decisions: boolean[] = [];
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["blocked"])],
      {
        acquireCandidate: () => undefined,
        onError: ({ willRetry }) => decisions.push(willRetry ?? false),
      }
    );

    expect(out.error).toBeDefined();
    expect(decisions).toEqual([false]);
  });

  it("reports stream concurrency state with the same attempt schema", async () => {
    const events: Array<{
      inFlight?: number;
      limit?: number;
      reason?: string;
    }> = [];
    await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["blocked"])],
      {
        acquireCandidate: () => undefined,
        candidateInFlight: () => 2,
        concurrencyLimit: () => 2,
        onAttempt: ({ concurrencyLimit, inFlight, reason }) =>
          events.push({ inFlight, limit: concurrencyLimit, reason }),
      }
    );

    expect(events).toContainEqual({
      inFlight: 2,
      limit: 2,
      reason: "concurrency",
    });
  });
});
