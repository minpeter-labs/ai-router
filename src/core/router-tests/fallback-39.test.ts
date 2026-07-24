import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouterHealthStore } from "../health-store";
import { createRouter } from "../router";
import { finishReason, okModel, usage } from "./test-kit";

describe("createRouter — fallback", () => {
  it("lets a newer cross-model success recover shared credential health", async () => {
    let rejectPrimary: ((error: unknown) => void) | undefined;
    let resolveRecovery: (() => void) | undefined;
    const primary = new MockLanguageModelV4({
      doGenerate: () => {
        if (primary.doGenerateCalls.length > 1) {
          return Promise.resolve({
            content: [{ text: "primary recovered", type: "text" }],
            finishReason,
            usage,
            warnings: [],
          });
        }
        return new Promise((_, reject) => {
          rejectPrimary = reject;
        });
      },
    });
    const recovery = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          resolveRecovery = () =>
            resolve({
              content: [{ text: "recovery", type: "text" }],
              finishReason,
              usage,
              warnings: [],
            });
        }),
    });
    const route = createRouter({
      fallback: { health: true, healthNamespace: "recovery" },
      models: {
        failing: [
          { healthKey: "shared-key", model: primary },
          { healthKey: "fallback", model: okModel("fallback") },
        ],
        recovering: [{ healthKey: "shared-key", model: recovery }],
      },
    });

    const failedRequest = generateText({
      model: route("failing"),
      prompt: "fail",
    });
    await vi.waitFor(() => expect(rejectPrimary).toBeTypeOf("function"));
    const recoveryRequest = generateText({
      model: route("recovering"),
      prompt: "recover",
    });
    await vi.waitFor(() => expect(resolveRecovery).toBeTypeOf("function"));

    rejectPrimary?.(
      Object.assign(new Error("credential limited"), { statusCode: 429 })
    );
    await expect(failedRequest).resolves.toMatchObject({ text: "fallback" });
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(1);

    resolveRecovery?.();
    await expect(recoveryRequest).resolves.toMatchObject({ text: "recovery" });
    expect(
      route
        .getHealthSnapshot()
        .filter(({ key }) => key.includes(":credential:"))
    ).toHaveLength(0);

    await expect(
      generateText({ model: route("failing"), prompt: "again" })
    ).resolves.toMatchObject({ text: "primary recovered" });
    expect(primary.doGenerateCalls).toHaveLength(2);
  });

  it("does not let an older same-ms cross-model success erase a newer failure", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      let rejectPrimary: ((error: unknown) => void) | undefined;
      let resolveRecovery: (() => void) | undefined;
      const primary = new MockLanguageModelV4({
        doGenerate: () =>
          new Promise((_, reject) => {
            rejectPrimary = reject;
          }),
      });
      const recovery = new MockLanguageModelV4({
        doGenerate: () =>
          new Promise((resolve) => {
            resolveRecovery = () =>
              resolve({
                content: [{ text: "stale recovery", type: "text" }],
                finishReason,
                usage,
                warnings: [],
              });
          }),
      });
      const route = createRouter({
        fallback: { health: true, healthNamespace: "stale-recovery" },
        models: {
          failing: [
            { healthKey: "shared-key", model: primary },
            { healthKey: "fallback", model: okModel("fallback") },
          ],
          recovering: [{ healthKey: "shared-key", model: recovery }],
        },
      });

      const recoveryRequest = generateText({
        model: route("recovering"),
        prompt: "older",
      });
      await vi.waitFor(() => expect(resolveRecovery).toBeTypeOf("function"));
      const failedRequest = generateText({
        model: route("failing"),
        prompt: "newer",
      });
      await vi.waitFor(() => expect(rejectPrimary).toBeTypeOf("function"));

      rejectPrimary?.(
        Object.assign(new Error("credential limited"), { statusCode: 429 })
      );
      await expect(failedRequest).resolves.toMatchObject({ text: "fallback" });
      resolveRecovery?.();
      await expect(recoveryRequest).resolves.toMatchObject({
        text: "stale recovery",
      });

      expect(
        route
          .getHealthSnapshot()
          .filter(({ key }) => key.includes(":credential:"))
      ).toHaveLength(1);
      await expect(
        generateText({ model: route("failing"), prompt: "again" })
      ).resolves.toMatchObject({ text: "fallback" });
      expect(primary.doGenerateCalls).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("orders same-ms attempts across routers sharing one health store", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      const store = new MemoryRouterHealthStore();
      let resolveRecovery: (() => void) | undefined;
      let rejectFailure: ((error: unknown) => void) | undefined;
      const recovery = new MockLanguageModelV4({
        doGenerate: () =>
          new Promise((resolve) => {
            resolveRecovery = () =>
              resolve({
                content: [{ text: "stale recovery", type: "text" }],
                finishReason,
                usage,
                warnings: [],
              });
          }),
      });
      const failing = new MockLanguageModelV4({
        doGenerate: () =>
          new Promise((_, reject) => {
            rejectFailure = reject;
          }),
      });
      const sharedFallback = {
        health: true,
        healthNamespace: "cross-router",
        healthStore: store,
      } as const;
      const recoveryRoute = createRouter({
        fallback: sharedFallback,
        models: { chat: [{ healthKey: "shared-key", model: recovery }] },
      });
      const failingRoute = createRouter({
        fallback: sharedFallback,
        models: {
          chat: [
            { healthKey: "shared-key", model: failing },
            { healthKey: "fallback", model: okModel("fallback") },
          ],
        },
      });

      const recoveryRequest = generateText({
        model: recoveryRoute("chat"),
        prompt: "older",
      });
      await vi.waitFor(() => expect(resolveRecovery).toBeTypeOf("function"));
      const failedRequest = generateText({
        model: failingRoute("chat"),
        prompt: "newer",
      });
      await vi.waitFor(() => expect(rejectFailure).toBeTypeOf("function"));

      rejectFailure?.(
        Object.assign(new Error("credential limited"), { statusCode: 429 })
      );
      await expect(failedRequest).resolves.toMatchObject({ text: "fallback" });
      resolveRecovery?.();
      await expect(recoveryRequest).resolves.toMatchObject({
        text: "stale recovery",
      });

      expect(
        failingRoute
          .getHealthSnapshot()
          .filter(({ key }) => key.includes(":credential:"))
      ).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });
});
