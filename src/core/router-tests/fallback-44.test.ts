import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  errorPartStreamModel,
  failingModel,
  genOptions,
  okModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("preserves caller abort identity after an earlier provider failure", async () => {
    const secondary = new MockLanguageModelV4({
      doGenerate: () => new Promise<never>(() => undefined),
    });
    const tertiary = okModel("must not run");
    const route = createRouter({
      fallback: { retryBudget: true },
      models: { chat: [failingModel("primary failed"), secondary, tertiary] },
    });
    const controller = new AbortController();
    const pending = asV4(route("chat")).doGenerate({
      ...genOptions,
      abortSignal: controller.signal,
    });
    while (secondary.doGenerateCalls.length === 0) {
      await Promise.resolve();
    }
    const reason = new Error("caller stopped fallback");

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(tertiary.doGenerateCalls).toHaveLength(0);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
  });

  it("preserves a total timeout after an earlier provider failure", async () => {
    const hanging = new MockLanguageModelV4({
      doGenerate: () => new Promise<never>(() => undefined),
    });
    const route = createRouter({
      fallback: { totalTimeout: 5 },
      models: { chat: [failingModel("primary failed"), hanging] },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).rejects.toMatchObject({
      code: "total_timeout",
      durationMs: 5,
      name: "RouterTimeoutError",
    });
  });

  it("does not let custom classifiers retry or poison health for router control errors", async () => {
    const hanging = new MockLanguageModelV4({
      doGenerate: () => new Promise<never>(() => undefined),
    });
    const timeoutFallback = okModel("must not run");
    const timeoutRoute = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "credential",
          statusCode: 429,
        }),
        health: true,
        totalTimeout: 5,
      },
      models: { chat: [hanging, timeoutFallback] },
    });

    await expect(
      asV4(timeoutRoute("chat")).doGenerate(genOptions)
    ).rejects.toMatchObject({ code: "total_timeout" });
    expect(timeoutFallback.doGenerateCalls).toHaveLength(0);
    expect(timeoutRoute.getHealthSnapshot("chat")).toEqual([]);

    const validatorFallback = okModel("must not run");
    const validatorRoute = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "credential",
        }),
        validateResult: (() => Promise.resolve(true)) as never,
      },
      models: { chat: [okModel("invalid contract"), validatorFallback] },
    });
    await expect(
      asV4(validatorRoute("chat")).doGenerate(genOptions)
    ).rejects.toMatchObject({ code: "validator_contract_error" });
    expect(validatorFallback.doGenerateCalls).toHaveLength(0);
  });

  it("censors the request when a classifier throws after an earlier provider failure", async () => {
    let classifications = 0;
    const primary = failingModel("primary failed");
    const secondary = failingModel("secondary failed");
    const tertiary = okModel("must not run");
    const failures: Array<{ index: number; scope?: string }> = [];
    const route = createRouter({
      fallback: {
        classifyFailure: () => {
          classifications += 1;
          if (classifications === 1) {
            return { retryable: true, scope: "transient" };
          }
          throw new Error("classifier implementation failed");
        },
        health: true,
        retryBudget: true,
      },
      models: {
        chat: [
          primary,
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: secondary,
          },
          tertiary,
        ],
      },
      onAttempt: ({ failure, index, outcome }) => {
        if (outcome === "failure") {
          failures.push({ index, scope: failure?.scope });
        }
      },
    });

    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toThrow(
      "secondary failed"
    );

    expect(failures).toEqual([
      { index: 0, scope: "transient" },
      { index: 1, scope: "request" },
    ]);
    expect(tertiary.doGenerateCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toHaveLength(1);
    expect(route.getHealthSnapshot("chat")[0].key).toContain(":unit:0");
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
  });

  it("censors a stream when a classifier throws after an earlier error part", async () => {
    let classifications = 0;
    const primary = errorPartStreamModel(new Error("primary stream failed"));
    const secondary = errorPartStreamModel(
      new Error("secondary stream failed")
    );
    const tertiary = streamingModel(["must not run"]);
    const failures: Array<{ index: number; scope?: string }> = [];
    const route = createRouter({
      fallback: {
        classifyFailure: () => {
          classifications += 1;
          if (classifications === 1) {
            return { retryable: true, scope: "transient" };
          }
          throw new Error("stream classifier implementation failed");
        },
        health: true,
        retryBudget: true,
      },
      models: {
        chat: [
          primary,
          {
            adaptiveConcurrency: {
              initial: 2,
              max: 4,
              min: 1,
            },
            model: secondary,
          },
          tertiary,
        ],
      },
      onAttempt: ({ failure, index, outcome }) => {
        if (outcome === "failure") {
          failures.push({ index, scope: failure?.scope });
        }
      },
    });

    await expect(
      collectStream(streamText({ model: route("chat"), prompt: "stream" }))
    ).rejects.toThrow("secondary stream failed");

    expect(failures).toEqual([
      { index: 0, scope: "transient" },
      { index: 1, scope: "request" },
    ]);
    expect(tertiary.doStreamCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toHaveLength(1);
    expect(route.getHealthSnapshot("chat")[0].key).toContain(":unit:0");
    expect(route.getAdmissionSnapshot("chat")[1]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 0,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
  });
});
