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
  it("snapshots stream warning indexes and fields exactly once", async () => {
    const reads = { index: 0, message: 0, type: 0 };
    const warning = Object.defineProperties(
      {},
      {
        message: {
          enumerable: true,
          get() {
            reads.message += 1;
            return "notice";
          },
        },
        type: {
          enumerable: true,
          get() {
            reads.type += 1;
            return "other";
          },
        },
      }
    );
    const warnings = new Proxy([warning], {
      get(target, property, receiver) {
        if (property === "0") {
          reads.index += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const model = chunkModel([
      { type: "stream-start", warnings } as never,
      { type: "text-start", id: "1" },
      { type: "text-delta", delta: "ok", id: "1" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);

    expect(out.error).toBeUndefined();
    expect(reads).toEqual({ index: 1, message: 1, type: 1 });
    expect(out.parts[0]).toEqual({
      type: "stream-start",
      warnings: [{ message: "notice", type: "other" }],
    });
  });

  it("snapshots nested stream finish and usage fields exactly once", async () => {
    const reads = new Map<string, number>();
    const once = (scope: string, values: Record<string, unknown>) =>
      Object.defineProperties(
        {},
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            {
              enumerable: true,
              get() {
                const label = `${scope}.${key}`;
                reads.set(label, (reads.get(label) ?? 0) + 1);
                return value;
              },
            },
          ])
        )
      );
    const nestedUsage = once("usage", {
      inputTokens: once("input", usage.inputTokens),
      outputTokens: once("output", usage.outputTokens),
      raw: { stable: true },
    });
    const finish = once("part", {
      finishReason: once("finish", finishReason),
      providerMetadata: { mock: {} },
      type: "finish",
      usage: nestedUsage,
    }) as LanguageModelV4StreamPart;
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", delta: "ok", id: "1" },
      { type: "text-end", id: "1" },
      finish,
    ]);

    const out = await runFallback([model]);

    expect(out.error).toBeUndefined();
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(out.parts.at(-1)).toEqual({
      finishReason,
      providerMetadata: { mock: {} },
      type: "finish",
      usage: { ...usage, raw: { stable: true } },
    });
  });

  it("passes unknown future stream part objects through unchanged", async () => {
    const future = { payload: { value: 1 }, type: "future-part" } as never;
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      future,
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);

    expect(out.error).toBeUndefined();
    expect(out.parts).toContain(future);
  });

  it("captures an unknown future part type once while preserving identity", async () => {
    let reads = 0;
    const future = Object.defineProperties(
      { payload: { value: 1 } },
      {
        type: {
          enumerable: true,
          get() {
            reads += 1;
            return reads === 1 ? "future-part" : "error";
          },
        },
      }
    ) as never;
    const fallback = textModel(["must not run"]);
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      future,
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model, fallback]);

    expect(out.error).toBeUndefined();
    expect(out.parts).toContain(future);
    // The downstream test consumer also inspects the opaque value. Its later
    // getter results must not retroactively alter the router's captured type.
    expect(reads).toBeGreaterThan(1);
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it("captures reader methods once and preserves their receivers", async () => {
    const reads = { cancel: 0, getReader: 0, read: 0, releaseLock: 0 };
    const chunks: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", delta: "safe", id: "1" },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ];
    let index = 0;
    const reader = {
      get cancel() {
        reads.cancel += 1;
        return function cancel(this: typeof reader) {
          expect(this).toBe(reader);
          return Promise.resolve();
        };
      },
      get read() {
        reads.read += 1;
        return function read(this: typeof reader) {
          expect(this).toBe(reader);
          const value = chunks[index];
          index += 1;
          return Promise.resolve(
            value === undefined ? { done: true, value } : { done: false, value }
          );
        };
      },
      get releaseLock() {
        reads.releaseLock += 1;
        return function releaseLock(this: typeof reader) {
          expect(this).toBe(reader);
          return Promise.reject(new Error("async release cleanup"));
        };
      },
    };
    const stream = {
      get getReader() {
        reads.getReader += 1;
        return function getReader(this: typeof stream) {
          expect(this).toBe(stream);
          return reader;
        };
      },
    };
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream }) as never,
    });

    const out = await runFallback([model]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("safe");
    expect(reads).toEqual({ cancel: 1, getReader: 1, read: 1, releaseLock: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
