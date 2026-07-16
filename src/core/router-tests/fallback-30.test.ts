import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  collectStream,
  errorPartStreamModel,
  finishReason,
  okModel,
  streamingModel,
  usage,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("allows only one concurrent family half-open probe across keys", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    let probeStarted = false;
    let resolveProbe:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const recovered = (): LanguageModelV4GenerateResult => ({
      content: [{ text: "family recovered", type: "text" }],
      finishReason,
      usage,
      warnings: [],
    });
    const family = new MockLanguageModelV4({
      doGenerate: () => {
        if (!healthy) {
          return Promise.reject(new Error("family unavailable"));
        }
        if (!probeStarted) {
          probeStarted = true;
          return new Promise((resolve) => {
            resolveProbe = resolve;
          });
        }
        return Promise.resolve(recovered());
      },
    });
    const firstFallback = okModel("first fallback");
    const secondFallback = okModel("second fallback");
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-concurrent-probe",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          firstFallback,
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          secondFallback,
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "outage" })
    ).resolves.toMatchObject({ text: "first fallback" });
    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));

    const probe = generateText({ model: route("first"), prompt: "probe" });
    await vi.waitFor(() => expect(family.doGenerateCalls).toHaveLength(2));
    await expect(
      generateText({ model: route("second"), prompt: "concurrent" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(family.doGenerateCalls).toHaveLength(2);
    expect(secondFallback.doGenerateCalls).toHaveLength(1);

    resolveProbe?.(recovered());
    await expect(probe).resolves.toMatchObject({ text: "family recovered" });
    await expect(
      generateText({ model: route("second"), prompt: "after recovery" })
    ).resolves.toMatchObject({ text: "family recovered" });

    expect(family.doGenerateCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    expect(
      route.getAdmissionSnapshot().every(({ inFlight }) => inFlight === 0)
    ).toBe(true);
    vi.useRealTimers();
  });

  it("holds one family probe lease until stream output is validated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    let probeStarted = false;
    let probeController:
      | ReadableStreamDefaultController<LanguageModelV4StreamPart>
      | undefined;
    const failedStream = errorPartStreamModel(new Error("family unavailable"));
    const recoveredStream = streamingModel(["family recovered"]);
    const family = new MockLanguageModelV4({
      doStream: (options) => {
        if (!healthy) {
          return failedStream.doStream(options);
        }
        if (!probeStarted) {
          probeStarted = true;
          return Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              start(controller) {
                probeController = controller;
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ id: "probe", type: "text-start" });
              },
            }),
          });
        }
        return recoveredStream.doStream(options);
      },
    });
    const firstFallback = streamingModel(["first fallback"]);
    const secondFallback = streamingModel(["second fallback"]);
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-concurrent-stream-probe",
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          firstFallback,
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          secondFallback,
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "outage" }))
    ).resolves.toBe("first fallback");
    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));

    const probe = collectStream(
      streamText({ model: route("first"), prompt: "probe" })
    );
    await vi.waitFor(() => expect(family.doStreamCalls).toHaveLength(2));
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "concurrent" })
      )
    ).resolves.toBe("second fallback");
    expect(family.doStreamCalls).toHaveLength(2);
    expect(secondFallback.doStreamCalls).toHaveLength(1);

    probeController?.enqueue({
      delta: "family recovered",
      id: "probe",
      type: "text-delta",
    });
    probeController?.enqueue({ id: "probe", type: "text-end" });
    probeController?.enqueue({ type: "finish", finishReason, usage });
    probeController?.close();
    await expect(probe).resolves.toBe("family recovered");
    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "after recovery" })
      )
    ).resolves.toBe("family recovered");

    expect(family.doStreamCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    expect(
      route.getAdmissionSnapshot().every(({ inFlight }) => inFlight === 0)
    ).toBe(true);
    vi.useRealTimers();
  });
});
