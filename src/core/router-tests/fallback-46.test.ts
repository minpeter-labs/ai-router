import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import type { Modality } from "../types";
import { asV4, failingModel, genOptions, okModel } from "./test-kit";

describe("createRouter — fallback", () => {
  it("treats arbitrary abort reasons as request failures when a provider ignores the signal", async () => {
    for (const reason of [new Error("caller stopped"), "caller stopped"]) {
      const failures: Array<{ scope?: string; willRetry?: boolean }> = [];
      const primary = new MockLanguageModelV4({
        doGenerate: () => new Promise<never>(() => undefined),
      });
      const secondary = okModel("must not run");
      const route = createRouter({
        fallback: { health: true, retryBudget: true },
        models: {
          chat: [
            {
              adaptiveConcurrency: { initial: 2, max: 4, min: 1 },
              healthKey: "primary-test-key",
              model: primary,
            },
            secondary,
          ],
        },
        onAttempt: ({ failure, outcome, willRetry }) => {
          if (outcome === "failure") {
            failures.push({ scope: failure?.scope, willRetry });
          }
        },
      });
      const controller = new AbortController();
      const pending = asV4(route("chat")).doGenerate({
        ...genOptions,
        abortSignal: controller.signal,
      });

      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
      expect(secondary.doGenerateCalls).toHaveLength(0);
      expect(failures).toEqual([{ scope: "request", willRetry: false }]);
      expect(route.getHealthSnapshot("chat")).toEqual([]);
      expect(route.getRetryBudgetSnapshot("chat")).toEqual([
        expect.objectContaining({ failures: 0, samples: 0 }),
      ]);
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
        successes: 0,
      });
    }
  });

  it("re-throws the LAST error when every candidate fails", async () => {
    const a = failingModel("first failure");
    const b = failingModel("second failure");
    const c = failingModel("last failure");

    const route = createRouter({
      models: {
        chat: [
          { provider: () => a, model: "a", supports: ["text"] },
          { provider: () => b, model: "b", supports: ["text"] },
          { provider: () => c, model: "c", supports: ["text"] },
        ],
      },
    });

    // The error surfaced is the one from the final candidate, not the first.
    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).rejects.toThrow("last failure");
    expect(a.doGenerateCalls).toHaveLength(1);
    expect(b.doGenerateCalls).toHaveLength(1);
    expect(c.doGenerateCalls).toHaveLength(1);
  });

  it("invokes onError once per failed candidate with { logicalId, entry, index, error }", async () => {
    const primary = failingModel("boom");
    const secondary = okModel("ok");

    const primaryEntry = {
      provider: () => primary,
      model: "p",
      supports: ["text"] as Modality[],
    };
    const secondaryEntry = {
      provider: () => secondary,
      model: "s",
      supports: ["text"] as Modality[],
    };

    const seen: Array<{
      logicalId: string;
      entry: unknown;
      index: number;
      error: unknown;
    }> = [];

    const route = createRouter({
      models: { chat: [primaryEntry, secondaryEntry] },
      onError: (info) => seen.push(info),
    });

    await generateText({ model: route("chat"), prompt: "hi" });

    // Only the failing primary triggers onError; the successful secondary does not.
    expect(seen).toHaveLength(1);
    expect(seen[0].logicalId).toBe("chat");
    expect(seen[0].index).toBe(0);
    expect(seen[0].entry).toBe(primaryEntry);
    expect((seen[0].error as Error).message).toBe("boom");
  });
});
