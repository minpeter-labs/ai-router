import { afterEach, describe, expect, it, vi } from "vitest";
import { withReasoningDetailsOnPrompt } from "../reasoning-roundtrip-input";
import { createOpenGatewayReasoningDetailsStoreMemo } from "../reasoning-roundtrip-store";
import { reasoningDetails } from "./test-kit";

describe("OpenGateway reasoningDetailsRef store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("memoizes semantically identical details across object key order", async () => {
    let stores = 0;
    const memo = createOpenGatewayReasoningDetailsStoreMemo({
      load: () => undefined,
      store: () => {
        stores += 1;
        return "same-ref";
      },
    });
    const first = [{ data: "value", format: "test", type: "reasoning" }];
    const reordered = [{ type: "reasoning", format: "test", data: "value" }];

    await expect(memo.store(first)).resolves.toBe("same-ref");
    await expect(memo.store(reordered)).resolves.toBe("same-ref");
    expect(stores).toBe(1);
  });

  it("bounds prompt replay load concurrency and total wait", async () => {
    vi.useFakeTimers();
    try {
      let loads = 0;
      const memo = createOpenGatewayReasoningDetailsStoreMemo({
        load: () => {
          loads += 1;
          return new Promise(() => undefined);
        },
        store: () => "ref",
      });
      const prompt = Array.from({ length: 100 }, (_, index) => ({
        content: [{ text: "answer", type: "text" as const }],
        providerOptions: {
          opengateway: { reasoningDetailsRef: `ref-${index}` },
        },
        role: "assistant" as const,
      }));
      const transformed = withReasoningDetailsOnPrompt(prompt, memo);
      await Promise.resolve();

      expect(loads).toBe(32);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(transformed).resolves.toHaveLength(100);
      expect(loads).toBe(32);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards partial replay results when the prompt-wide deadline wins", async () => {
    vi.useFakeTimers();
    try {
      let loads = 0;
      const memo = createOpenGatewayReasoningDetailsStoreMemo({
        load: () => {
          loads += 1;
          return loads === 1
            ? Promise.resolve(reasoningDetails)
            : new Promise(() => undefined);
        },
        store: () => "ref",
      });
      const prompt = Array.from({ length: 33 }, (_, index) => ({
        content: [{ text: "answer", type: "text" as const }],
        providerOptions: {
          opengateway: { reasoningDetailsRef: `ref-${index}` },
        },
        role: "assistant" as const,
      }));
      const transformed = withReasoningDetailsOnPrompt(prompt, memo);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(transformed).resolves.toEqual(prompt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed memo refs without caching them", async () => {
    let attempts = 0;
    const memo = createOpenGatewayReasoningDetailsStoreMemo({
      load: () => undefined,
      store: () => {
        attempts += 1;
        return attempts === 1 ? "" : "valid-ref";
      },
    });
    await expect(memo.store(reasoningDetails)).rejects.toThrow("invalid ref");
    await expect(memo.store(reasoningDetails)).resolves.toBe("valid-ref");
  });
});
