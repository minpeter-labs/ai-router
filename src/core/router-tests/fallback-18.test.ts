import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { RouterConcurrencyError } from "../admission-utils";
import { createRouter } from "../router";
import { asV4, finishReason, genOptions, okModel, usage } from "./test-kit";

describe("createRouter — fallback", () => {
  it("rejects hostile call options before provider and health state mutation", async () => {
    const primary = okModel("must not run");
    const secondary = okModel("must not run either");
    const events: string[] = [];
    const route = createRouter({
      fallback: { health: true, retryBudget: true },
      models: { chat: [primary, secondary] },
      onAttempt: ({ outcome }) => events.push(outcome),
    });
    const hostilePart = Object.defineProperty({ type: "text" }, "text", {
      enumerable: true,
      get() {
        throw new Error("text getter failed");
      },
    });
    const options = {
      prompt: [{ content: [hostilePart], role: "user" }],
    } as LanguageModelV4CallOptions;

    await expect(asV4(route("chat")).doGenerate(options)).rejects.toMatchObject(
      {
        code: "call_options_contract_error",
      }
    );
    let signalReads = 0;
    const hostileSignalOptions = Object.defineProperty(
      { prompt: [] },
      "abortSignal",
      {
        get() {
          signalReads += 1;
          throw new Error("signal getter failed");
        },
      }
    ) as LanguageModelV4CallOptions;
    await expect(
      asV4(route("chat")).doGenerate(hostileSignalOptions)
    ).rejects.toMatchObject({ code: "call_options_contract_error" });
    expect(signalReads).toBe(1);
    expect(primary.doGenerateCalls).toHaveLength(0);
    expect(secondary.doGenerateCalls).toHaveLength(0);
    expect(events).toEqual([]);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 0,
    });
  });

  it("overflows concurrent requests to the next credential", async () => {
    let resolvePrimary:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const primary = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          resolvePrimary = resolve;
        }),
    });
    const secondary = okModel("overflow");
    const route = createRouter({
      models: {
        chat: [
          { model: primary, healthKey: "primary", maxConcurrency: 1 },
          { model: secondary, healthKey: "secondary", maxConcurrency: 1 },
        ],
      },
    });

    const first = generateText({ model: route("chat"), prompt: "first" });
    await vi.waitFor(() => expect(primary.doGenerateCalls).toHaveLength(1));
    const second = generateText({ model: route("chat"), prompt: "second" });
    await expect(second).resolves.toMatchObject({ text: "overflow" });
    resolvePrimary?.({
      content: [{ type: "text", text: "primary" }],
      finishReason,
      usage,
      warnings: [],
    });
    await expect(first).resolves.toMatchObject({ text: "primary" });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
  });

  it("shares credential concurrency across logical models", async () => {
    let releaseFirst:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const held = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    });
    const sharedOther = okModel("must overflow");
    const overflow = okModel("overflow");
    const route = createRouter({
      models: {
        first: [{ model: held, healthKey: "shared", maxConcurrency: 1 }],
        second: [
          { model: sharedOther, healthKey: "shared", maxConcurrency: 1 },
          { model: overflow, healthKey: "other", maxConcurrency: 1 },
        ],
      },
    });

    const pending = generateText({ model: route("first"), prompt: "hold" });
    await vi.waitFor(() => expect(held.doGenerateCalls).toHaveLength(1));
    await expect(
      generateText({ model: route("second"), prompt: "overflow" })
    ).resolves.toMatchObject({ text: "overflow" });

    expect(sharedOther.doGenerateCalls).toHaveLength(0);
    expect(route.getAdmissionSnapshot("first")[0].inFlight).toBe(1);
    expect(route.getAdmissionSnapshot("second")[0].inFlight).toBe(1);
    releaseFirst?.({
      content: [{ type: "text", text: "done" }],
      finishReason,
      usage,
      warnings: [],
    });
    await pending;
  });

  it("waits for the final candidate concurrency slot", async () => {
    let call = 0;
    let resolveFirst:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const model = new MockLanguageModelV4({
      doGenerate: () => {
        call += 1;
        if (call === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          content: [{ type: "text", text: "waited" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const route = createRouter({
      fallback: { concurrencyWaitTimeout: 100 },
      models: {
        chat: [{ model, healthKey: "only", maxConcurrency: 1 }],
      },
    });

    const first = generateText({ model: route("chat"), prompt: "first" });
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));
    const second = generateText({ model: route("chat"), prompt: "second" });
    await vi.waitFor(() =>
      expect(route.getAdmissionSnapshot("chat")[0].waiting).toBe(1)
    );
    resolveFirst?.({
      content: [{ type: "text", text: "first" }],
      finishReason,
      usage,
      warnings: [],
    });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("surfaces capacity-only rejection as a concurrency error", async () => {
    let releaseFirst:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const model = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    });
    const route = createRouter({
      models: { chat: [{ model, maxConcurrency: 1 }] },
    });
    const first = asV4(route("chat")).doGenerate(genOptions);
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));

    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toEqual(
      expect.objectContaining({
        code: "concurrency_exhausted",
        name: "RouterConcurrencyError",
      })
    );
    const error = await Promise.resolve(
      asV4(route("chat")).doGenerate(genOptions)
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RouterConcurrencyError);

    releaseFirst?.({
      content: [{ type: "text", text: "done" }],
      finishReason,
      usage,
      warnings: [],
    });
    await first;
  });
});
