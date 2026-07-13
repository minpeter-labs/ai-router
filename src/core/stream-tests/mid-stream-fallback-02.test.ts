import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import { wrapStreamResult } from "../stream";
import {
  callOptions,
  chunkModel,
  drive,
  errorPartModel,
  finishReason,
  resolved,
  runFallback,
  textModel,
  usage,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("consumes async optional state-hook results and requires a boolean budget result", async () => {
    const candidates = [
      resolved(errorPartModel(new Error("primary failed")), 0),
      resolved(textModel(["ok"]), 1),
    ];
    const firstResult = await candidates[0].model.doStream(callOptions);
    let observedOutcome: readonly unknown[] | undefined;
    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      isBudgetFailure: (() => thenable) as never,
      logicalId: "chat",
      onAdvance: (() =>
        Promise.reject(new Error("async cooldown advance"))) as never,
      onCandidateFailure: (() =>
        Promise.reject(new Error("async health failure"))) as never,
      onCandidateSuccess: (() =>
        Promise.reject(new Error("async health success"))) as never,
      onRequestOutcome: ((...args: unknown[]) => {
        observedOutcome = args;
        return Promise.reject(new Error("async budget outcome"));
      }) as never,
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(observedOutcome).toEqual([true, false, false]);
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes async operational control-hook results", async () => {
    for (const overrides of [
      {
        acquireCandidate: () => 1,
        candidateAvailable: (() =>
          Promise.reject(new Error("async availability"))) as never,
      },
      {
        acquireCandidate: () => 1,
        prepareCandidate: (() =>
          Promise.reject(new Error("async preparation"))) as never,
      },
      {
        acquireCandidate: (() =>
          Promise.reject(new Error("async admission"))) as never,
      },
    ]) {
      const primary = errorPartModel(new Error("primary failed"));
      const fallback = textModel(["must not open"]);
      const firstResult = await primary.doStream(callOptions);
      const wrapped = wrapStreamResult({
        candidates: [resolved(primary, 0), resolved(fallback, 1)],
        firstResult,
        logicalId: "chat",
        options: callOptions,
        retryAfterOutput: false,
        shouldRetry: defaultShouldRetryThisError,
        startIndex: 0,
        ...overrides,
      });

      await expect(drive(wrapped.stream)).resolves.toMatchObject({
        error: expect.anything(),
      });
      expect(fallback.doStreamCalls).toHaveLength(0);
    }

    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      nextOrderingToken: (() =>
        Promise.reject(new Error("async ordering token"))) as never,
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });
    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects non-boolean availability and preparation results", async () => {
    for (const overrides of [
      {
        acquireCandidate: () => 1,
        candidateAvailable: (() => ({})) as never,
      },
      {
        acquireCandidate: () => 1,
        prepareCandidate: (() => "yes") as never,
      },
    ]) {
      const primary = errorPartModel(new Error("primary failed"));
      const firstResult = await primary.doStream(callOptions);
      const wrapped = wrapStreamResult({
        candidates: [resolved(primary, 0), resolved(textModel(["unused"]), 1)],
        firstResult,
        logicalId: "chat",
        options: callOptions,
        retryAfterOutput: false,
        shouldRetry: defaultShouldRetryThisError,
        startIndex: 0,
        ...overrides,
      });

      await expect(drive(wrapped.stream)).resolves.toMatchObject({
        error: expect.anything(),
      });
    }
  });

  it("consumes and omits malformed diagnostic metric hook results", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const firstResult = await primary.doStream(callOptions);
    const events: Array<{ concurrencyLimit?: number; inFlight?: number }> = [];
    const wrapped = wrapStreamResult({
      acquireCandidate: () => undefined,
      candidateInFlight: (() =>
        Promise.reject(new Error("async in-flight metric"))) as never,
      candidates: [resolved(primary)],
      concurrencyLimit: (() =>
        Promise.reject(new Error("async limit metric"))) as never,
      firstResult,
      logicalId: "chat",
      onAttempt: (event) => events.push(event),
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await drive(wrapped.stream);

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.concurrencyLimit === undefined)).toBe(
      true
    );
    expect(events.every((event) => event.inFlight === undefined)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots known stream part accessors once", async () => {
    let delta = "stable";
    const reads = new Map<string, number>();
    const once = (name: string, read: () => unknown) => ({
      enumerable: true,
      get() {
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        if (count > 1) {
          throw new Error(`${name} read twice`);
        }
        return read();
      },
    });
    const statefulDelta = Object.defineProperties(
      {},
      {
        delta: once("delta", () => delta),
        id: once("id", () => "1"),
        providerMetadata: once("providerMetadata", () => ({ mock: {} })),
        type: once("type", () => "text-delta"),
        unknown: {
          enumerable: true,
          get() {
            throw new Error("unknown extension must not be read");
          },
        },
      }
    ) as LanguageModelV4StreamPart;
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      statefulDelta,
      { type: "text-end", id: "1" },
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);
    delta = "mutated";

    expect(out.text).toBe("stable");
    expect(Object.fromEntries(reads)).toEqual({
      delta: 1,
      id: 1,
      providerMetadata: 1,
      type: 1,
    });
  });
});
