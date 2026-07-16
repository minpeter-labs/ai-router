import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import type { RouterHealthRecord } from "../types";
import {
  asV4,
  errorPartStreamModel,
  failingModel,
  genOptions,
  okModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — configuration errors", () => {
  it("censors stream fallback when backoff timer registration fails", async () => {
    const primary = errorPartStreamModel(new Error("primary stream failed"));
    const secondary = streamingModel(["must not run"]);
    const attempts: Array<{
      attempt?: number;
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const route = createRouter({
      fallback: { backoff: 1000, health: true, retryBudget: true },
      models: {
        chat: [
          {
            adaptiveConcurrency: { initial: 2, max: 4, min: 1 },
            model: primary,
          },
          secondary,
        ],
      },
      onAttempt: ({ attempt, index, outcome, reason }) =>
        attempts.push({ attempt, index, outcome, reason }),
    });
    const result = await asV4(route("chat")).doStream(genOptions);
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => {
      throw new Error("timer unavailable");
    });
    try {
      const reader = result.stream.getReader();
      const pending = (async () => {
        while (!(await reader.read()).done) {
          // Drain until fallback backoff attempts to register its timer.
        }
      })();

      await expect(pending).rejects.toMatchObject({
        code: "timer_unavailable",
      });
      expect(primary.doStreamCalls).toHaveLength(1);
      expect(secondary.doStreamCalls).toHaveLength(0);
      expect(route.getHealthSnapshot("chat")).toHaveLength(1);
      expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
        inFlight: 0,
        limit: 2,
        successes: 0,
      });
      expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
        failures: 0,
        samples: 0,
      });
      expect(attempts).toEqual([
        {
          attempt: 1,
          index: 0,
          outcome: "failure",
          reason: undefined,
        },
      ]);
    } finally {
      timer.mockRestore();
    }
  });

  it("captures custom health-store methods once and preserves receivers", async () => {
    const reads = { compareAndSet: 0, delete: 0, entries: 0, get: 0, set: 0 };
    const records = new Map<string, RouterHealthRecord>();
    const store = {
      records,
      get compareAndSet() {
        reads.compareAndSet += 1;
        return function compareAndSet(
          this: typeof store,
          key: string,
          expectedVersion: number | undefined,
          value: RouterHealthRecord
        ) {
          if (this.records.get(key)?.version !== expectedVersion) {
            return false;
          }
          this.records.set(key, value);
          return true;
        };
      },
      get delete() {
        reads.delete += 1;
        return function deleteRecord(this: typeof store, key: string) {
          this.records.delete(key);
        };
      },
      get entries() {
        reads.entries += 1;
        return function entries(this: typeof store) {
          return this.records.entries();
        };
      },
      get get() {
        reads.get += 1;
        return function getRecord(this: typeof store, key: string) {
          return this.records.get(key);
        };
      },
      get set() {
        reads.set += 1;
        return function setRecord(
          this: typeof store,
          key: string,
          value: RouterHealthRecord
        ) {
          this.records.set(key, value);
        };
      },
    };
    const route = createRouter({
      fallback: { health: true, healthStore: store },
      models: { chat: [failingModel("down"), okModel("recovered")] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "recovered" });
    route.getHealthSnapshot("chat");
    expect(reads).toEqual({
      compareAndSet: 1,
      delete: 1,
      entries: 1,
      get: 1,
      set: 1,
    });
  });
});
