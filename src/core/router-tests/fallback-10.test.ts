import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  errorPartStreamModel,
  failingStreamModel,
  genOptions,
  okModel,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("falls back when a provider exceeds attemptTimeout", async () => {
    const hanging = new MockLanguageModelV4({
      doGenerate: () => new Promise(() => undefined),
    });
    const secondary = okModel("after timeout");
    const route = createRouter({
      fallback: { attemptTimeout: 5 },
      models: { chat: [hanging, secondary] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "after timeout" });
  });

  it("consumes rejected fields in a generate result that resolves after timeout", async () => {
    let resolveLate:
      | ((result: LanguageModelV4GenerateResult) => void)
      | undefined;
    const hanging = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise<LanguageModelV4GenerateResult>((resolve) => {
          resolveLate = resolve;
        }),
    });
    const route = createRouter({
      fallback: { attemptTimeout: 5 },
      models: { chat: [hanging, okModel("after timeout")] },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "after timeout" }],
    });
    resolveLate?.({
      get content(): never {
        throw new Error("late content unavailable");
      },
      finishReason: { raw: "stop", unified: "stop" },
      providerMetadata: {
        mock: Array.from({ length: 50_000 }, () => ({})),
      },
      request: {
        body: {
          prompt: Promise.reject(new Error("late generate field rejected")),
        },
      },
      usage,
      warnings: [],
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("cancels a provider stream that opens after its attempt timed out", async () => {
    let resolveOpen:
      | ((result: LanguageModelV4StreamResult) => void)
      | undefined;
    let cancelled = false;
    const hanging = new MockLanguageModelV4({
      doStream: () =>
        new Promise<LanguageModelV4StreamResult>((resolve) => {
          resolveOpen = resolve;
        }),
    });
    const route = createRouter({
      fallback: { attemptTimeout: 5 },
      models: { chat: [hanging, streamingModel(["after timeout"])] },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("after timeout");

    resolveOpen?.({
      stream: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("cancels a late stream opened by a timed-out mid-stream fallback", async () => {
    let resolveOpen:
      | ((result: LanguageModelV4StreamResult) => void)
      | undefined;
    let cancelled = false;
    const hangingFallback = new MockLanguageModelV4({
      doStream: () =>
        new Promise<LanguageModelV4StreamResult>((resolve) => {
          resolveOpen = resolve;
        }),
    });
    const route = createRouter({
      fallback: { attemptTimeout: 5 },
      models: {
        chat: [
          failingStreamModel("first failed"),
          hangingFallback,
          streamingModel(["third survived"]),
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("third survived");

    resolveOpen?.({
      stream: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("censors a total-timeout fallback open and cancels its late stream", async () => {
    let resolveOpen:
      | ((result: LanguageModelV4StreamResult) => void)
      | undefined;
    let cancelled = false;
    const secondary = new MockLanguageModelV4({
      doStream: () =>
        new Promise<LanguageModelV4StreamResult>((resolve) => {
          resolveOpen = resolve;
        }),
    });
    const tertiary = streamingModel(["must not open"]);
    const route = createRouter({
      fallback: {
        health: true,
        retryBudget: true,
        totalTimeout: 20,
      },
      models: {
        chat: [
          errorPartStreamModel(new Error("primary stream failed")),
          {
            adaptiveConcurrency: { initial: 2, max: 4, min: 1 },
            model: secondary,
          },
          tertiary,
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).rejects.toMatchObject({ code: "total_timeout" });

    expect(tertiary.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([
      expect.objectContaining({
        key: expect.stringContaining(":unit:0"),
        record: expect.objectContaining({ failures: 1 }),
      }),
    ]);
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });

    resolveOpen?.({
      stream: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
});
