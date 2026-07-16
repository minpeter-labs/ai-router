import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  failingModel,
  finishReason,
  genOptions,
  okModel,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("records timeout then cancel at an equal content deadline", async () => {
    vi.useFakeTimers();
    try {
      const reason = new Error("equal-deadline consumer cancel second");
      const hanging = new MockLanguageModelV4({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>(),
          }),
      });
      const fallback = new MockLanguageModelV4({
        doStream: () => new Promise<never>(() => undefined),
      });
      const attempts: Array<{
        attempt?: number;
        index: number;
        outcome: string;
      }> = [];
      const route = createRouter({
        fallback: {
          firstContentTimeout: 50,
          health: true,
          retryBudget: true,
        },
        models: { chat: [hanging, fallback] },
        onAttempt: ({ attempt, index, outcome }) =>
          attempts.push({ attempt, index, outcome }),
      });
      const result = await asV4(route("chat")).doStream(genOptions);
      const reader = result.stream.getReader();
      const pending = reader.read();
      await Promise.resolve();
      let cancellation: Promise<void> | undefined;
      setTimeout(() => {
        cancellation = reader.cancel(reason);
      }, 50);

      await vi.advanceTimersByTimeAsync(50);
      await cancellation;
      await pending;

      expect(fallback.doStreamCalls).toHaveLength(1);
      expect(attempts).toEqual([
        { attempt: 1, index: 0, outcome: "failure" },
        { attempt: 2, index: 1, outcome: "cancelled" },
      ]);
      expect(route.getHealthSnapshot("chat")).toHaveLength(1);
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 0,
      });
      expect(
        route
          .getAdmissionSnapshot("chat")
          .every(({ inFlight }) => inFlight === 0)
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back when a provider returns a malformed stream result", async () => {
    const malformed = new MockLanguageModelV4({
      doStream: async () => ({}) as never,
    });
    const route = createRouter({
      models: { chat: [malformed, streamingModel(["valid fallback"])] },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("valid fallback");
    expect(malformed.doStreamCalls).toHaveLength(1);
  });

  it("falls back when acquiring a provider stream reader throws", async () => {
    const malformed = new MockLanguageModelV4({
      doStream: (async () =>
        ({
          stream: {
            getReader() {
              throw new Error("reader unavailable");
            },
          },
        }) as never) as never,
    });
    const route = createRouter({
      models: { chat: [malformed, streamingModel(["reader fallback"])] },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("reader fallback");
  });

  it("limits the number of provider attempts", async () => {
    const first = failingModel("first");
    const second = failingModel("second");
    const third = okModel("third");
    const route = createRouter({
      fallback: { maxAttempts: 2 },
      models: { chat: [first, second, third] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).rejects.toThrow();
    expect(third.doGenerateCalls).toHaveLength(0);
  });

  it("isolates mutable call options between fallback attempts", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: (options) => {
        const message = options.prompt[0];
        if (message.role !== "system") {
          const part = message.content[0] as { text?: string };
          part.text = "mutated";
          message.content.length = 0;
        }
        options.prompt.length = 0;
        if (options.headers !== undefined) {
          options.headers.authorization = "mutated";
        }
        options.stopSequences?.push("mutated");
        if (options.providerOptions?.mock !== undefined) {
          options.providerOptions.mock.mode = "mutated";
        }
        throw new Error("primary failed after mutation");
      },
    });
    const secondary = new MockLanguageModelV4({
      doGenerate: (options) => {
        expect(options.prompt).toEqual([
          {
            content: [{ text: "original", type: "text" }],
            role: "user",
          },
        ]);
        expect(options.headers).toEqual({ authorization: "original" });
        expect(options.stopSequences).toEqual(["stop"]);
        expect(options.providerOptions).toEqual({ mock: { mode: "original" } });
        return Promise.resolve({
          content: [{ text: "isolated", type: "text" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const options: LanguageModelV4CallOptions = {
      headers: { authorization: "original" },
      prompt: [
        {
          content: [{ text: "original", type: "text" }],
          role: "user",
        },
      ],
      providerOptions: { mock: { mode: "original" } },
      stopSequences: ["stop"],
    };
    const route = createRouter({ models: { chat: [primary, secondary] } });

    await expect(
      asV4(route("chat")).doGenerate(options)
    ).resolves.toMatchObject({
      content: [{ text: "isolated", type: "text" }],
    });
    expect(options.prompt[0]).toMatchObject({
      content: [{ text: "original", type: "text" }],
    });
    expect(options.headers).toEqual({ authorization: "original" });
    expect(options.stopSequences).toEqual(["stop"]);
    expect(options.providerOptions).toEqual({ mock: { mode: "original" } });
  });
});
