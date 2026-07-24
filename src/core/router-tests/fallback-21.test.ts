import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  errorPartStreamModel,
  finishReason,
  genOptions,
  okModel,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("does not let an older slow success retrain AIMD after newer congestion", async () => {
    let resolveSlow: (() => void) | undefined;
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            resolveSlow = () =>
              resolve({
                content: [{ type: "text", text: "slow success" }],
                finishReason,
                usage,
                warnings: [],
              });
          });
        }
        return Promise.reject(
          Object.assign(new Error("newer overload"), { statusCode: 503 })
        );
      },
    });
    const route = createRouter({
      models: {
        chat: [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 1,
              initial: 4,
              max: 8,
              min: 1,
            },
            model,
          },
        ],
      },
    });

    const slow = asV4(route("chat")).doGenerate(genOptions);
    await vi.waitFor(() => expect(resolveSlow).toBeTypeOf("function"));
    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toThrow(
      "newer overload"
    );
    resolveSlow?.();
    await expect(slow).resolves.toMatchObject({
      content: [{ type: "text", text: "slow success" }],
    });

    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      limit: 2,
      successes: 0,
    });
  });

  it("recovers reduced AIMD capacity gradually after a half-open probe succeeds", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let calls = 0;
      const primary = new MockLanguageModelV4({
        doGenerate: () => {
          calls += 1;
          if (calls === 1) {
            return Promise.reject(
              Object.assign(new Error("overloaded"), { statusCode: 503 })
            );
          }
          return Promise.resolve({
            content: [{ type: "text", text: "primary recovered" }],
            finishReason,
            usage,
            warnings: [],
          });
        },
      });
      const route = createRouter({
        fallback: { health: true },
        models: {
          chat: [
            {
              adaptiveConcurrency: {
                increaseAfterSuccesses: 2,
                initial: 4,
                max: 8,
                min: 1,
              },
              model: primary,
            },
            { model: okModel("fallback") },
          ],
        },
      });

      await expect(
        generateText({ model: route("chat"), prompt: "fail" })
      ).resolves.toMatchObject({
        text: "fallback",
      });
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        limit: 2,
        successes: 0,
      });
      const cooldownUntil =
        route.getHealthSnapshot("chat")[0].record.cooldownUntil;
      now = cooldownUntil + 1;

      await expect(
        generateText({ model: route("chat"), prompt: "probe" })
      ).resolves.toMatchObject({
        text: "primary recovered",
      });
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        limit: 2,
        successes: 1,
      });

      await expect(
        generateText({ model: route("chat"), prompt: "healthy" })
      ).resolves.toMatchObject({
        text: "primary recovered",
      });
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        limit: 3,
        successes: 0,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("applies one health failure and AIMD decrease per failed stream half-open probe", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const overload = Object.assign(new Error("stream overloaded"), {
        statusCode: 503,
      });
      const primary = errorPartStreamModel(overload);
      const route = createRouter({
        fallback: { health: true },
        models: {
          chat: [
            {
              adaptiveConcurrency: {
                initial: 4,
                max: 8,
                min: 1,
              },
              model: primary,
            },
            { model: streamingModel(["fallback"]) },
          ],
        },
      });

      await expect(
        collectStream(streamText({ model: route("chat"), prompt: "first" }))
      ).resolves.toBe("fallback");
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({ limit: 2 });
      expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(1);

      now = route.getHealthSnapshot("chat")[0].record.cooldownUntil + 1;
      await expect(
        collectStream(streamText({ model: route("chat"), prompt: "probe" }))
      ).resolves.toBe("fallback");

      expect(primary.doStreamCalls).toHaveLength(2);
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({ limit: 1 });
      expect(route.getHealthSnapshot("chat")[0].record.failures).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });
});
