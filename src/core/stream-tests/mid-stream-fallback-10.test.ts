import { describe, expect, it, vi } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import { wrapStreamResult } from "../stream";
import {
  callOptions,
  chunkModel,
  errorPartModel,
  finishReason,
  resolved,
  runFallback,
  textModel,
  usage,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("removes fallback capacity waiting on consumer cancel", async () => {
    let waitStarted = false;
    let waitAborted = false;
    const released: number[] = [];
    const releasedProbes: Array<string | undefined> = [];
    const outcomes: boolean[] = [];
    const attempts: Array<{
      attempt?: number;
      inFlight?: number;
      index: number;
      limit?: number;
      outcome: string;
    }> = [];
    const primary = errorPartModel(new Error("primary failed"));
    const fallback = textModel(["must not open"]);
    const candidates = [resolved(primary, 0), resolved(fallback, 1)];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      acquireCandidate: () => undefined,
      candidateInFlight: () => 2,
      candidates,
      concurrencyLimit: () => 2,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      onAttempt: ({ attempt, concurrencyLimit, inFlight, index, outcome }) =>
        attempts.push({
          attempt,
          inFlight,
          index,
          limit: concurrencyLimit,
          outcome,
        }),
      onRequestOutcome: (success) => outcomes.push(success),
      prepareCandidate: (candidate) => {
        candidate.probeLease = {
          key: `local-${candidate.fullIndex}`,
          probingUntil: 123,
          source: "local",
        };
        return true;
      },
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
      releaseProbeCandidate: (candidate) => {
        releasedProbes.push(candidate.probeLease?.source);
        candidate.probeLease = undefined;
      },
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
      startInFlight: 1,
      waitForCandidate: (_candidate, signal) =>
        new Promise((_, reject) => {
          waitStarted = true;
          signal?.addEventListener(
            "abort",
            () => {
              waitAborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
        }),
    });
    const reader = wrapped.stream.getReader();
    const pendingRead = reader.read();
    while (!waitStarted) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await reader.cancel("consumer stopped waiting");
    await pendingRead;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(waitAborted).toBe(true);
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(released).toEqual([0]);
    expect(releasedProbes).toEqual([undefined, "local"]);
    expect(outcomes).toEqual([]);
    expect(attempts).toEqual([
      { attempt: 1, inFlight: 1, index: 0, limit: 2, outcome: "failure" },
      {
        attempt: undefined,
        inFlight: 2,
        index: 1,
        limit: 2,
        outcome: "cancelled",
      },
    ]);
  });

  it("reports consumer cancellation during fallback backoff", async () => {
    const attempts: Array<{
      attempt?: number;
      inFlight?: number;
      index: number;
      limit?: number;
      outcome: string;
    }> = [];
    const released: number[] = [];
    const primary = errorPartModel(new Error("primary failed"));
    const fallback = textModel(["must not open"]);
    const candidates = [resolved(primary, 0), resolved(fallback, 1)];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      backoff: 1000,
      candidateInFlight: () => 0,
      candidates,
      concurrencyLimit: () => 2,
      firstResult,
      logicalId: "chat",
      onAttempt: ({ attempt, concurrencyLimit, inFlight, index, outcome }) =>
        attempts.push({
          attempt,
          inFlight,
          index,
          limit: concurrencyLimit,
          outcome,
        }),
      options: callOptions,
      releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
      startInFlight: 1,
    });
    const reader = wrapped.stream.getReader();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    const pendingRead = reader.read();
    while (!released.includes(0)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    try {
      await reader.cancel("consumer stopped backoff");
      await pendingRead;
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      random.mockRestore();
    }

    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(attempts).toEqual([
      { attempt: 1, inFlight: 1, index: 0, limit: 2, outcome: "failure" },
      {
        attempt: undefined,
        inFlight: 0,
        index: 1,
        limit: 2,
        outcome: "cancelled",
      },
    ]);
  });

  it("falls back when a stream closes before content and without finish", async () => {
    const incomplete = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
    ]);
    const out = await runFallback([incomplete, textModel(["fallback"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("fallback");
  });

  it("falls back when a stream finishes without any output", async () => {
    const empty = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "finish", finishReason, usage },
    ]);
    const out = await runFallback([empty, textModel(["fallback"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("fallback");
    expect(out.parts.filter(({ type }) => type === "finish")).toHaveLength(1);
  });

  it("bounds buffered framing before output and falls back on overflow", async () => {
    const noisy = chunkModel(
      Array.from({ length: 1025 }, () => ({
        type: "stream-start" as const,
        warnings: [],
      }))
    );
    const out = await runFallback([noisy, textModel(["fallback"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("fallback");
    expect(noisy.doStreamCalls).toHaveLength(1);
  });

  it("bounds cumulative framing provider-metadata structure", async () => {
    const metadata = () => ({
      mock: { items: Array.from({ length: 6000 }, () => ({})) },
    });
    const noisy = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1", providerMetadata: metadata() },
      { type: "text-start", id: "2", providerMetadata: metadata() },
    ]);

    const out = await runFallback([noisy, textModel(["fallback"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("fallback");
    expect(
      out.parts.some(
        (part) =>
          part.type === "text-start" &&
          part.providerMetadata?.mock !== undefined
      )
    ).toBe(false);
  });
});
