import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  failingModel,
  failingModelStatus,
  genOptions,
  okModel,
} from "./test-kit";

describe("createRouter — error classification (P0-B)", () => {
  it("does not poison candidate health for an unrelated terminal 404", async () => {
    const primary = failingModelStatus(404, "job not found");
    const route = createRouter({
      fallback: { health: true },
      models: { chat: [primary, okModel("must not run")] },
    });
    const model = asV4(route("chat"));

    await expect(model.doGenerate(genOptions)).rejects.toThrow("job not found");
    await expect(model.doGenerate(genOptions)).rejects.toThrow("job not found");

    expect(primary.doGenerateCalls).toHaveLength(2);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
  });

  it("retries a provider-scoped 400 on the next candidate", async () => {
    const primary = failingModelStatus(400, "bad request");
    const secondary = okModel("secondary");
    const seen: Array<{ willRetry?: boolean }> = [];

    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
      onError: (info) => seen.push({ willRetry: info.willRetry }),
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "secondary" });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
    expect(seen).toEqual([{ willRetry: true }]);
  });

  it("honors a custom shouldRetryThisError that refuses to retry", async () => {
    const primary = failingModel("overloaded"); // retryable by default
    const secondary = okModel("secondary");

    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
      fallback: { shouldRetry: () => false },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).rejects.toThrow("overloaded");
    expect(secondary.doGenerateCalls).toHaveLength(0);
  });

  it("lets a custom shouldRetry replace a default non-retryable decision", async () => {
    const primary = failingModelStatus(410, "provider-specific gone");
    const secondary = okModel("secondary");
    const route = createRouter({
      models: { chat: [primary, secondary] },
      fallback: { shouldRetry: () => true },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "secondary" });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });

  it("requires strict boolean retry hooks and valid structured classifications", async () => {
    const malformedRetryFallback = okModel("must not run");
    const malformedRetry = createRouter({
      fallback: { shouldRetry: (() => "yes") as never },
      models: { chat: [failingModel("down"), malformedRetryFallback] },
    });
    await expect(
      asV4(malformedRetry("chat")).doGenerate(genOptions)
    ).rejects.toThrow("down");
    expect(malformedRetryFallback.doGenerateCalls).toHaveLength(0);

    const malformedClassifyFallback = okModel("must not run");
    const malformedClassify = createRouter({
      fallback: { classifyFailure: (() => undefined) as never },
      models: { chat: [failingModel("down"), malformedClassifyFallback] },
    });
    await expect(
      asV4(malformedClassify("chat")).doGenerate(genOptions)
    ).rejects.toThrow("down");
    expect(malformedClassifyFallback.doGenerateCalls).toHaveLength(0);

    const fractionalStatusFallback = okModel("must not run");
    const fractionalStatus = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "credential",
          statusCode: 429.5,
        }),
      },
      models: { chat: [failingModel("down"), fractionalStatusFallback] },
    });
    await expect(
      asV4(fractionalStatus("chat")).doGenerate(genOptions)
    ).rejects.toThrow("down");
    expect(fractionalStatusFallback.doGenerateCalls).toHaveLength(0);

    for (const statusCode of [99, 600]) {
      const outOfRangeFallback = okModel("must not run");
      const outOfRange = createRouter({
        fallback: {
          classifyFailure: () => ({
            retryable: true,
            scope: "credential",
            statusCode,
          }),
        },
        models: { chat: [failingModel("down"), outOfRangeFallback] },
      });
      await expect(
        asV4(outOfRange("chat")).doGenerate(genOptions)
      ).rejects.toThrow("down");
      expect(outOfRangeFallback.doGenerateCalls).toHaveLength(0);
    }

    let coercions = 0;
    const coercibleScopeFallback = okModel("must not run");
    const coercibleScope = createRouter({
      fallback: {
        classifyFailure: (() => ({
          retryable: true,
          scope: {
            toString() {
              coercions += 1;
              return "transient";
            },
          },
        })) as never,
      },
      models: { chat: [failingModel("down"), coercibleScopeFallback] },
    });
    await expect(
      asV4(coercibleScope("chat")).doGenerate(genOptions)
    ).rejects.toThrow("down");
    expect(coercions).toBe(0);
    expect(coercibleScopeFallback.doGenerateCalls).toHaveLength(0);

    const asyncFallback = okModel("must not run");
    const asyncClassification = createRouter({
      fallback: {
        classifyFailure: (() =>
          Promise.reject(new Error("async classifier rejected"))) as never,
      },
      models: { chat: [failingModel("down"), asyncFallback] },
    });
    await expect(
      asV4(asyncClassification("chat")).doGenerate(genOptions)
    ).rejects.toThrow("down");
    await Promise.resolve();
    expect(asyncFallback.doGenerateCalls).toHaveLength(0);
  });

  it("reads structured classification fields once", async () => {
    const reads = new Map<string, number>();
    const values = {
      cooldownMs: 25,
      retryable: true,
      retryAfterMs: 50,
      scope: "transient",
      statusCode: 503,
    } as const;
    const classification = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          {
            get() {
              reads.set(key, (reads.get(key) ?? 0) + 1);
              return value;
            },
          },
        ])
      )
    );
    const fallback = okModel("recovered");
    const route = createRouter({
      fallback: { classifyFailure: (() => classification) as never },
      models: { chat: [failingModel("down"), fallback] },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ text: "recovered", type: "text" }],
    });
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(reads.size).toBe(Object.keys(values).length);
  });
});
