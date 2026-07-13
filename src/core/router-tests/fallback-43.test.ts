import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import { asV4, failingModel, genOptions, okModel } from "./test-kit";

describe("createRouter — fallback", () => {
  it("rolls the logical millisecond when the fixed-width ordering counter fills", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const routed = asV4(
        createRouter({ models: { chat: [okModel()] } })("chat")
      ) as unknown as {
        nextOrderingToken(): string;
        ordering: { lastOrderingMs: number; orderingCounter: number };
      };
      routed.ordering.lastOrderingMs = 2000;
      routed.ordering.orderingCounter = 999_999;

      const first = routed.nextOrderingToken().split(":");
      const second = routed.nextOrderingToken().split(":");
      expect(first[1]).toBe("0000000002001");
      expect(first[3]).toBe("000000");
      expect(second[1]).toBe("0000000002001");
      expect(second[3]).toBe("000001");
    } finally {
      now.mockRestore();
    }
  });

  it("keeps ordering tokens valid when the wall clock is hostile", () => {
    const routed = asV4(
      createRouter({ models: { chat: [okModel()] } })("chat")
    ) as unknown as {
      nextOrderingToken(): string;
      ordering: { lastOrderingMs: number; orderingCounter: number };
    };
    routed.ordering.lastOrderingMs = 2000;
    routed.ordering.orderingCounter = 0;
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValueOnce(Number.MAX_VALUE);
      now.mockReturnValueOnce(Number.MAX_SAFE_INTEGER);
      now.mockReturnValueOnce(1.5);
      now.mockImplementationOnce(() => {
        throw new Error("clock unavailable");
      });

      const tokens = [
        routed.nextOrderingToken(),
        routed.nextOrderingToken(),
        routed.nextOrderingToken(),
        routed.nextOrderingToken(),
      ];

      expect(tokens.map((token) => token.split(":"))).toEqual([
        ["v1", "0000000002000", expect.any(String), "000001"],
        ["v1", "0000000002000", expect.any(String), "000002"],
        ["v1", "0000000002000", expect.any(String), "000003"],
        ["v1", "0000000002000", expect.any(String), "000004"],
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("never falls back after a caller abort", async () => {
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
    const secondary = okModel("must not run");
    const route = createRouter({ models: { chat: [primary, secondary] } });
    const controller = new AbortController();
    const promise = asV4(route("chat")).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      abortSignal: controller.signal,
    } as LanguageModelV4CallOptions);
    controller.abort(new DOMException("aborted", "AbortError"));

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(secondary.doGenerateCalls).toHaveLength(0);
  });

  it("allows a custom classifier to retry a provider-origin abort", async () => {
    const providerAbort = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(new DOMException("provider stopped", "AbortError")),
    });
    const fallback = okModel("recovered from provider abort");
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({ retryable: true, scope: "transient" }),
      },
      models: { chat: [providerAbort, fallback] },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "recovered from provider abort" });
    expect(fallback.doGenerateCalls).toHaveLength(1);
  });

  it("does not let a custom classifier override an actual caller abort", async () => {
    const controller = new AbortController();
    const primary = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) =>
        new Promise((_, reject) =>
          abortSignal?.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true }
          )
        ),
    });
    const fallback = okModel("must not run");
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({ retryable: true, scope: "transient" }),
      },
      models: { chat: [primary, fallback] },
    });
    const reason = new DOMException("caller stopped", "AbortError");
    const request = asV4(route("chat")).doGenerate({
      ...genOptions,
      abortSignal: controller.signal,
    });
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it("uses a stable AbortError when an aborted signal reason is unreadable", async () => {
    const model = okModel("must not run");
    const route = createRouter({ models: { chat: [model] } });
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(controller.signal, "reason", {
      get() {
        throw new Error("reason getter unavailable");
      },
    });

    await expect(
      asV4(route("chat")).doGenerate({
        ...genOptions,
        abortSignal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("does not let an unreadable aborted flag replace a provider failure", async () => {
    const controller = new AbortController();
    let reads = 0;
    Object.defineProperty(controller.signal, "aborted", {
      get() {
        reads += 1;
        if (reads === 6) {
          throw new Error("aborted flag temporarily unavailable");
        }
        return false;
      },
    });
    const fallback = okModel("fallback survived signal accessor");
    const route = createRouter({
      models: { chat: [failingModel("primary failed"), fallback] },
    });

    await expect(
      asV4(route("chat")).doGenerate({
        ...genOptions,
        abortSignal: controller.signal,
      })
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({ text: "fallback survived signal accessor" }),
      ],
    });
    expect(fallback.doGenerateCalls).toHaveLength(1);
    expect(reads).toBeGreaterThanOrEqual(6);
  });

  it("continues routing when the wall clock throws", async () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("wall clock unavailable");
    });
    try {
      const fallback = okModel("recovered without wall clock");
      const route = createRouter({
        models: { chat: [failingModel("primary failed"), fallback] },
      });

      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).resolves.toMatchObject({
        content: [
          expect.objectContaining({ text: "recovered without wall clock" }),
        ],
      });
      expect(fallback.doGenerateCalls).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });
});
