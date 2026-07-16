import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
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
  it("releases a cancelled family stream probe for a sibling key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    let probeStarted = false;
    let probeCancels = 0;
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
              cancel() {
                probeCancels += 1;
              },
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ id: "probe", type: "text-start" });
              },
            }),
          });
        }
        return recoveredStream.doStream(options);
      },
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-cancelled-stream-probe",
        retryBudget: true,
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["first fallback"]),
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          streamingModel(["second fallback"]),
        ],
      },
    });

    await expect(
      collectStream(streamText({ model: route("first"), prompt: "outage" }))
    ).resolves.toBe("first fallback");
    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const result = await asV4(route("first")).doStream(genOptions);
    const reader = result.stream.getReader();
    const pending = reader.read();
    await vi.waitFor(() => expect(family.doStreamCalls).toHaveLength(2));

    await reader.cancel("consumer stopped family probe");
    await pending;

    expect(probeCancels).toBe(1);
    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    await expect(
      collectStream(
        streamText({ model: route("second"), prompt: "sibling probe" })
      )
    ).resolves.toBe("family recovered");
    expect(family.doStreamCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    expect(
      route.getAdmissionSnapshot().every(({ inFlight }) => inFlight === 0)
    ).toBe(true);
    vi.useRealTimers();
  });

  it("releases a caller-aborted family generate probe for a sibling key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    let probeStarted = false;
    const recovered = (): LanguageModelV4GenerateResult => ({
      content: [{ text: "family recovered", type: "text" }],
      finishReason,
      usage,
      warnings: [],
    });
    const family = new MockLanguageModelV4({
      doGenerate: (options) => {
        if (!healthy) {
          return Promise.reject(new Error("family unavailable"));
        }
        if (!probeStarted) {
          probeStarted = true;
          return new Promise((_, reject) => {
            options.abortSignal?.addEventListener(
              "abort",
              () => reject(options.abortSignal?.reason),
              { once: true }
            );
          });
        }
        return Promise.resolve(recovered());
      },
    });
    const route = createRouter({
      fallback: {
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-aborted-generate-probe",
        retryBudget: true,
      },
      models: {
        first: [
          {
            healthKey: "family-key-a",
            model: family,
            providerFamily: "shared-family",
          },
          okModel("first fallback"),
        ],
        second: [
          {
            healthKey: "family-key-b",
            model: family,
            providerFamily: "shared-family",
          },
          okModel("second fallback"),
        ],
      },
    });

    await expect(
      generateText({ model: route("first"), prompt: "outage" })
    ).resolves.toMatchObject({ text: "first fallback" });
    healthy = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const caller = new AbortController();
    const reason = new Error("caller stopped family generate probe");
    const probe = generateText({
      abortSignal: caller.signal,
      model: route("first"),
      prompt: "probe",
    });
    const probeExpectation = expect(probe).rejects.toBe(reason);
    await vi.waitFor(() => expect(family.doGenerateCalls).toHaveLength(2));

    caller.abort(reason);
    await probeExpectation;

    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(1);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    await expect(
      generateText({ model: route("second"), prompt: "sibling probe" })
    ).resolves.toMatchObject({ text: "family recovered" });
    expect(family.doGenerateCalls).toHaveLength(3);
    expect(route.getHealthSnapshot()).toEqual([]);
    vi.useRealTimers();
  });
});
