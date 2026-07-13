import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  failingModelStatus,
  finishReason,
  genOptions,
  okModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("does not let an older stream finish erase a newer cross-model failure", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      let finishRecovery: (() => void) | undefined;
      const recovery = new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ id: "1", type: "text-start" });
              controller.enqueue({
                delta: "older stream",
                id: "1",
                type: "text-delta",
              });
              controller.enqueue({ id: "1", type: "text-end" });
              finishRecovery = () => {
                controller.enqueue({ type: "finish", finishReason, usage });
                controller.close();
              };
            },
          }),
        }),
      });
      const failing = failingModelStatus(429, "credential limited");
      const route = createRouter({
        fallback: { health: true, healthNamespace: "stream-recovery" },
        models: {
          failing: [
            { healthKey: "shared-key", model: failing },
            { healthKey: "fallback", model: okModel("fallback") },
          ],
          recovering: [{ healthKey: "shared-key", model: recovery }],
        },
      });

      const recoveryRequest = collectStream(
        streamText({ model: route("recovering"), prompt: "older" })
      );
      await vi.waitFor(() => expect(finishRecovery).toBeTypeOf("function"));
      await expect(
        generateText({ model: route("failing"), prompt: "newer" })
      ).resolves.toMatchObject({ text: "fallback" });

      finishRecovery?.();
      await expect(recoveryRequest).resolves.toBe("older stream");
      expect(
        route
          .getHealthSnapshot()
          .filter(({ key }) => key.includes(":credential:"))
      ).toHaveLength(1);
      await expect(
        generateText({ model: route("failing"), prompt: "again" })
      ).resolves.toMatchObject({ text: "fallback" });
      expect(failing.doGenerateCalls).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("lets a newer stream finish recover an older cross-model failure", async () => {
    let rejectPrimary: ((error: unknown) => void) | undefined;
    let finishRecovery: (() => void) | undefined;
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
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ id: "1", type: "text-start" });
            controller.enqueue({
              delta: "newer stream",
              id: "1",
              type: "text-delta",
            });
            controller.enqueue({ id: "1", type: "text-end" });
            finishRecovery = () => {
              controller.enqueue({ type: "finish", finishReason, usage });
              controller.close();
            };
          },
        }),
      }),
    });
    const route = createRouter({
      fallback: { health: true, healthNamespace: "new-stream-recovery" },
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
      prompt: "older",
    });
    await vi.waitFor(() => expect(rejectPrimary).toBeTypeOf("function"));
    const recoveryRequest = collectStream(
      streamText({ model: route("recovering"), prompt: "newer" })
    );
    await vi.waitFor(() => expect(finishRecovery).toBeTypeOf("function"));

    rejectPrimary?.(
      Object.assign(new Error("credential limited"), { statusCode: 429 })
    );
    await expect(failedRequest).resolves.toMatchObject({ text: "fallback" });
    finishRecovery?.();
    await expect(recoveryRequest).resolves.toBe("newer stream");

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

  it("does not let an older cancelled stream recover a newer shared failure", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      let upstreamCancels = 0;
      const recovery = new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            cancel() {
              upstreamCancels += 1;
            },
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ id: "1", type: "text-start" });
              controller.enqueue({
                delta: "partial",
                id: "1",
                type: "text-delta",
              });
            },
          }),
        }),
      });
      const failing = failingModelStatus(429, "credential limited");
      const route = createRouter({
        fallback: { health: true, healthNamespace: "cancel-recovery" },
        models: {
          failing: [
            { healthKey: "shared-key", model: failing },
            { healthKey: "fallback", model: okModel("fallback") },
          ],
          recovering: [{ healthKey: "shared-key", model: recovery }],
        },
      });

      const result = await asV4(route("recovering")).doStream(genOptions);
      const reader = result.stream.getReader();
      expect((await reader.read()).value?.type).toBe("stream-start");
      expect((await reader.read()).value?.type).toBe("text-start");
      expect((await reader.read()).value?.type).toBe("text-delta");

      await expect(
        generateText({ model: route("failing"), prompt: "newer" })
      ).resolves.toMatchObject({ text: "fallback" });
      await reader.cancel("consumer stopped");

      expect(upstreamCancels).toBe(1);
      expect(route.getAdmissionSnapshot("recovering")[0].inFlight).toBe(0);
      expect(
        route
          .getHealthSnapshot()
          .filter(({ key }) => key.includes(":credential:"))
      ).toHaveLength(1);
      await expect(
        generateText({ model: route("failing"), prompt: "again" })
      ).resolves.toMatchObject({ text: "fallback" });
      expect(failing.doGenerateCalls).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });
});
