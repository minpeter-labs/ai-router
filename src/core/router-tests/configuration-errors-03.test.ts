import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { OrderingTokenSource } from "../ordering";
import { createRouter } from "../router";
import {
  asV4,
  failingModel,
  genOptions,
  okModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — configuration errors", () => {
  it("consumes Promise-valued ordering entropy", async () => {
    const uuid = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(
        () => Promise.reject(new Error("async UUID entropy")) as never
      );
    const random = vi
      .spyOn(Math, "random")
      .mockImplementation(
        () => Promise.reject(new Error("async random entropy")) as never
      );
    try {
      const route = createRouter({ models: { chat: [okModel("safe")] } });
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).resolves.toMatchObject({ content: [{ text: "safe" }] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      random.mockRestore();
      uuid.mockRestore();
    }
  });

  it("consumes Promise-valued ordering clock samples", async () => {
    const source = new OrderingTokenSource();
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(
        () => Promise.reject(new Error("async ordering clock")) as never
      );
    try {
      expect(String(source.next()).startsWith("v1:")).toBe(true);
    } finally {
      now.mockRestore();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not start or fan out providers when timer registration fails", async () => {
    const primary = okModel("must not run");
    const secondary = okModel("must not run either");
    const route = createRouter({
      fallback: { attemptTimeout: 1000 },
      models: { chat: [primary, secondary] },
    });
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => {
      throw new Error("timer unavailable");
    });
    try {
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).rejects.toMatchObject({ code: "timer_unavailable" });
      expect(primary.doGenerateCalls).toHaveLength(0);
      expect(secondary.doGenerateCalls).toHaveLength(0);
    } finally {
      timer.mockRestore();
    }
  });

  it("generates without AbortController when no cancellation controls are configured", async () => {
    const OriginalAbortController = globalThis.AbortController;
    vi.stubGlobal(
      "AbortController",
      class BrokenAbortController {
        constructor() {
          throw new Error("AbortController unavailable");
        }
      }
    );
    try {
      const route = createRouter({ models: { chat: [okModel("safe")] } });
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).resolves.toMatchObject({ content: [{ text: "safe" }] });
    } finally {
      vi.stubGlobal("AbortController", OriginalAbortController);
    }
  });

  it("does not fan out when required cancellation infrastructure is unavailable", async () => {
    const OriginalAbortController = globalThis.AbortController;
    const primary = okModel("must not run");
    const secondary = okModel("must not run either");
    vi.stubGlobal(
      "AbortController",
      class BrokenAbortController {
        constructor() {
          throw new Error("AbortController unavailable");
        }
      }
    );
    try {
      const route = createRouter({
        fallback: { attemptTimeout: 1000 },
        models: { chat: [primary, secondary] },
      });
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).rejects.toMatchObject({ code: "cancellation_unavailable" });
      expect(primary.doGenerateCalls).toHaveLength(0);
      expect(secondary.doGenerateCalls).toHaveLength(0);
    } finally {
      vi.stubGlobal("AbortController", OriginalAbortController);
    }
  });

  it("cancels an opened upstream when wrapper stream construction fails", async () => {
    const OriginalReadableStream = globalThis.ReadableStream;
    let cancelCalls = 0;
    const upstream = {
      cancel() {
        cancelCalls += 1;
        return Promise.resolve();
      },
    };
    const primary = new MockLanguageModelV4({
      doStream: async () => ({ stream: upstream }) as never,
    });
    const secondary = streamingModel(["must not run"]);
    const route = createRouter({ models: { chat: [primary, secondary] } });
    vi.stubGlobal(
      "ReadableStream",
      class BrokenReadableStream {
        constructor() {
          throw new Error("ReadableStream unavailable");
        }
      }
    );
    try {
      await expect(
        asV4(route("chat")).doStream(genOptions)
      ).rejects.toMatchObject({ code: "stream_unavailable" });
      expect(cancelCalls).toBe(1);
      expect(primary.doStreamCalls).toHaveLength(1);
      expect(secondary.doStreamCalls).toHaveLength(0);
      expect(route.getAdmissionSnapshot("chat")[0]?.inFlight).toBe(0);
    } finally {
      vi.stubGlobal("ReadableStream", OriginalReadableStream);
    }
  });

  it("stops fallback when backoff timer registration fails", async () => {
    const primary = failingModel("primary failed");
    const secondary = okModel("must not run");
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
    });
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => {
      throw new Error("timer unavailable");
    });
    try {
      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).rejects.toMatchObject({ code: "timer_unavailable" });
      expect(primary.doGenerateCalls).toHaveLength(1);
      expect(secondary.doGenerateCalls).toHaveLength(0);
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
    } finally {
      timer.mockRestore();
    }
  });
});
