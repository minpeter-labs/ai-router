import { streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  finishReason,
  genOptions,
  okModel,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("stops fallback but preserves provider failure state when shouldRetry throws", async () => {
    let calls = 0;
    const primary = new MockLanguageModelV4({
      doGenerate: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            content: [{ type: "text", text: "initial success" }],
            finishReason,
            usage,
            warnings: [],
          });
        }
        return Promise.reject(new Error("provider failed"));
      },
    });
    const fallback = okModel("must not run");
    const route = createRouter({
      fallback: {
        health: true,
        retryBudget: true,
        shouldRetry: () => {
          throw new Error("retry policy failed");
        },
      },
      models: {
        chat: [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: primary,
          },
          fallback,
        ],
      },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "initial success" }],
    });
    expect(route.getAdmissionSnapshot("chat")[0].successes).toBe(1);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toThrow(
      "provider failed"
    );
    expect(fallback.doGenerateCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(1);
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
  });

  it("stops stream fallback but preserves error-part state when shouldRetry throws", async () => {
    let calls = 0;
    const primary = new MockLanguageModelV4({
      doStream: () => {
        calls += 1;
        return {
          stream: simulateReadableStream({
            chunks:
              calls === 1
                ? [
                    { type: "stream-start" as const, warnings: [] },
                    { type: "text-start" as const, id: "1" },
                    {
                      type: "text-delta" as const,
                      id: "1",
                      delta: "initial stream success",
                    },
                    { type: "text-end" as const, id: "1" },
                    { type: "finish" as const, finishReason, usage },
                  ]
                : [
                    { type: "stream-start" as const, warnings: [] },
                    {
                      type: "error" as const,
                      error: new Error("stream provider failed"),
                    },
                  ],
          }),
        };
      },
    });
    const fallback = streamingModel(["must not run"]);
    const route = createRouter({
      fallback: {
        health: true,
        retryBudget: true,
        shouldRetry: () => {
          throw new Error("stream retry policy failed");
        },
      },
      models: {
        chat: [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: primary,
          },
          fallback,
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "valid" }))
    ).resolves.toBe("initial stream success");
    expect(route.getAdmissionSnapshot("chat")[0].successes).toBe(1);

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "failure" }))
    ).rejects.toThrow("stream provider failed");
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(1);
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
  });

  it("omits health transitions for request-scoped caller aborts", async () => {
    const transitions: Array<string | undefined> = [];
    const primary = new MockLanguageModelV4({
      doGenerate: (options) =>
        new Promise((_, reject) => {
          options.abortSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        }),
    });
    const route = createRouter({
      fallback: { health: true },
      models: { chat: [primary] },
      onAttempt: ({ healthTransition }) => transitions.push(healthTransition),
    });
    const controller = new AbortController();
    const pending = asV4(route("chat")).doGenerate({
      ...genOptions,
      abortSignal: controller.signal,
    });
    controller.abort(new DOMException("aborted", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transitions).toEqual([undefined]);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
  });
});
