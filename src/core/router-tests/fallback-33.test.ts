import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  asV4,
  collectStream,
  errorPartStreamModel,
  genOptions,
  okModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — fallback", () => {
  it("releases a caller-aborted family stream probe for a sibling key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let healthy = false;
    let probeStarted = false;
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
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ id: "probe", type: "text-start" });
                options.abortSignal?.addEventListener(
                  "abort",
                  () => controller.error(options.abortSignal?.reason),
                  { once: true }
                );
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
        healthNamespace: "family-aborted-stream-probe",
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
    const caller = new AbortController();
    const reason = new Error("caller stopped family stream probe");
    const result = await asV4(route("first")).doStream({
      ...genOptions,
      abortSignal: caller.signal,
    });
    const reader = result.stream.getReader();
    const pending = reader.read();
    const pendingExpectation = expect(pending).rejects.toBe(reason);
    await vi.waitFor(() => expect(family.doStreamCalls).toHaveLength(2));

    caller.abort(reason);
    await pendingExpectation;

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
    vi.useRealTimers();
  });

  it("recools a family after a generate probe attempt timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let hang = false;
    const family = new MockLanguageModelV4({
      doGenerate: () =>
        hang
          ? new Promise<never>(() => undefined)
          : Promise.reject(new Error("family unavailable")),
    });
    const firstFallback = okModel("first fallback");
    const secondFallback = okModel("second fallback");
    const route = createRouter({
      fallback: {
        attemptTimeout: 10,
        classifyFailure: () => ({
          retryable: true,
          scope: "provider-family",
        }),
        health: true,
        healthNamespace: "family-attempt-timeout",
        retryBudget: true,
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
    hang = true;
    vi.setSystemTime(new Date("2026-01-01T00:00:15.001Z"));
    const probe = generateText({ model: route("first"), prompt: "probe" });
    await vi.advanceTimersByTimeAsync(10);
    await expect(probe).resolves.toMatchObject({ text: "first fallback" });

    expect(family.doGenerateCalls).toHaveLength(2);
    expect(
      route.getHealthSnapshot().find(({ key }) => key.includes(":family:"))
        ?.record.failures
    ).toBe(2);
    expect(
      route
        .getHealthSnapshot()
        .some(({ record }) => record.probingUntil !== undefined)
    ).toBe(false);
    expect(route.getRetryBudgetSnapshot("first")[0]).toMatchObject({
      failures: 0,
      samples: 2,
    });

    await expect(
      generateText({ model: route("second"), prompt: "still cooling" })
    ).resolves.toMatchObject({ text: "second fallback" });
    expect(family.doGenerateCalls).toHaveLength(2);
    vi.useRealTimers();
  });
});
