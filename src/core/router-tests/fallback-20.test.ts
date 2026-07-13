import { generateText, streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { collectStream, finishReason, streamingModel, usage } from "./test-kit";

describe("createRouter — fallback", () => {
  it.each([
    429, 503,
  ])("adjusts adaptive concurrency with AIMD after status %i", async (statusCode) => {
    let calls = 0;
    const limits: number[] = [];
    const inFlights: number[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: () => {
        calls += 1;
        if (calls === 5) {
          return Promise.reject(
            Object.assign(new Error("limited"), { statusCode })
          );
        }
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const route = createRouter({
      models: {
        chat: [
          {
            model,
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 1,
              max: 3,
              min: 1,
            },
          },
        ],
      },
      onAttempt: ({ concurrencyLimit, inFlight }) => {
        if (concurrencyLimit !== undefined) {
          limits.push(concurrencyLimit);
        }
        if (inFlight !== undefined) {
          inFlights.push(inFlight);
        }
      },
    });
    for (let index = 0; index < 4; index++) {
      await generateText({ model: route("chat"), prompt: String(index) });
    }
    await expect(
      generateText({ model: route("chat"), prompt: "limited" })
    ).rejects.toThrow("limited");

    expect(limits).toEqual([1, 2, 2, 3, 1]);
    expect(inFlights).toEqual([1, 1, 1, 1, 1]);
  });

  it("reports stream AIMD and in-flight metrics at the generate-equivalent settlement point", async () => {
    let calls = 0;
    const limits: number[] = [];
    const inFlights: number[] = [];
    const model = new MockLanguageModelV4({
      doStream: () => {
        calls += 1;
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks:
              calls === 5
                ? [
                    { type: "stream-start", warnings: [] },
                    {
                      type: "error",
                      error: Object.assign(new Error("limited"), {
                        statusCode: 429,
                      }),
                    },
                  ]
                : [
                    { type: "stream-start", warnings: [] },
                    { type: "text-start", id: "1" },
                    { type: "text-delta", id: "1", delta: "ok" },
                    { type: "text-end", id: "1" },
                    { type: "finish", finishReason, usage },
                  ],
          }),
        });
      },
    });
    const route = createRouter({
      models: {
        chat: [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 1,
              max: 3,
              min: 1,
            },
            model,
          },
        ],
      },
      onAttempt: ({ concurrencyLimit, inFlight }) => {
        if (concurrencyLimit !== undefined) {
          limits.push(concurrencyLimit);
        }
        if (inFlight !== undefined) {
          inFlights.push(inFlight);
        }
      },
    });

    for (let index = 0; index < 4; index++) {
      await expect(
        collectStream(
          streamText({ model: route("chat"), prompt: String(index) })
        )
      ).resolves.toBe("ok");
    }
    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "limited" }))
    ).rejects.toThrow("limited");

    expect(limits).toEqual([1, 2, 2, 3, 1]);
    expect(inFlights).toEqual([1, 1, 1, 1, 1]);
  });

  it("preserves post-output stream failure phase and pre-release ownership metrics", async () => {
    const primary = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "partial" },
              {
                type: "error",
                error: Object.assign(new Error("mid-stream limited"), {
                  statusCode: 429,
                }),
              },
            ],
          }),
        }),
    });
    const failures: Array<{
      inFlight?: number;
      limit?: number;
      phase?: string;
    }> = [];
    const route = createRouter({
      fallback: { retryAfterOutput: true },
      models: {
        chat: [
          {
            adaptiveConcurrency: { initial: 2, max: 4, min: 1 },
            model: primary,
          },
          streamingModel(["recovered"]),
        ],
      },
      onAttempt: ({ concurrencyLimit, inFlight, outcome, phase }) => {
        if (outcome === "failure") {
          failures.push({ inFlight, limit: concurrencyLimit, phase });
        }
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "hi" }))
    ).resolves.toBe("partialrecovered");
    expect(failures).toEqual([{ inFlight: 1, limit: 1, phase: "stream-mid" }]);
  });
});
