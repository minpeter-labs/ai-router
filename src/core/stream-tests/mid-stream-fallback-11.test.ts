import { describe, expect, it } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import { type ResolvedEntry, wrapStreamResult } from "../stream";
import type { FailureClassification } from "../types";
import {
  callOptions,
  chunkModel,
  drive,
  errorPartModel,
  resolved,
  runFallback,
  textModel,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("treats whitespace-only streamed text as empty", async () => {
    const empty = textModel(["  ", "\n"]);
    const out = await runFallback([empty, textModel(["fallback"])]);

    expect(out.text).toBe("fallback");
  });

  it("surfaces an incomplete stream after content instead of silently succeeding", async () => {
    const incomplete = chunkModel([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "partial" },
    ]);
    const seen: unknown[] = [];
    const out = await runFallback([incomplete], {
      onError: ({ error }) => seen.push(error),
    });

    expect(out.text).toBe("partial");
    expect(out.error).toMatchObject({ code: "incomplete_model_stream" });
    expect(seen).toHaveLength(1);
  });

  it("isolates attempt failure payload mutation from terminal surfacing", async () => {
    const first = new Error("retry first");
    const terminal = new Error("terminal request failure");
    const out = await runFallback(
      [errorPartModel(first), errorPartModel(terminal)],
      {
        classifyFailure: (error) =>
          error === terminal
            ? { retryable: false, scope: "request" }
            : { retryable: true, scope: "transient" },
        onAttempt: ({ failure, index }) => {
          if (index === 1 && failure !== undefined) {
            failure.scope = "transient";
            failure.statusCode = 503;
          }
        },
      }
    );

    expect(out.error).toBe(terminal);
    expect(out.error).not.toBeInstanceOf(AggregateError);
  });

  it("isolates health and budget hook classification mutation from retry", async () => {
    for (const hook of ["budget", "health"] as const) {
      const primaryError = new Error(`${hook} primary failure`);
      const observed: Array<FailureClassification | undefined> = [];
      const out = await runFallback(
        [errorPartModel(primaryError), textModel(["recovered"])],
        {
          classifyFailure: () => ({
            retryable: true,
            scope: "transient",
            statusCode: 503,
          }),
          ...(hook === "budget"
            ? {
                isBudgetFailure: (failure: FailureClassification) => {
                  failure.cooldownMs = Promise.reject(
                    new Error("async budget cooldown")
                  ) as never;
                  failure.retryAfterMs = Promise.reject(
                    new Error("async budget retry-after")
                  ) as never;
                  failure.retryable = Promise.reject(
                    new Error("async budget retryable")
                  ) as never;
                  failure.scope = Promise.reject(
                    new Error("async budget scope")
                  ) as never;
                  failure.statusCode = Promise.reject(
                    new Error("async budget status")
                  ) as never;
                  return true;
                },
              }
            : {
                onCandidateFailure: (
                  _candidate: ResolvedEntry,
                  failure: FailureClassification
                ) => {
                  failure.cooldownMs = Promise.reject(
                    new Error("async health cooldown")
                  ) as never;
                  failure.retryAfterMs = Promise.reject(
                    new Error("async health retry-after")
                  ) as never;
                  failure.retryable = Promise.reject(
                    new Error("async health retryable")
                  ) as never;
                  failure.scope = Promise.reject(
                    new Error("async health scope")
                  ) as never;
                  failure.statusCode = Promise.reject(
                    new Error("async health status")
                  ) as never;
                },
              }),
          onAttempt: ({ failure }) => observed.push(failure),
        }
      );

      expect(out.error).toBeUndefined();
      expect(out.text).toBe("recovered");
      expect(observed[0]).toMatchObject({
        retryable: true,
        scope: "transient",
        statusCode: 503,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it("isolates health hook candidate ownership mutation from release", async () => {
    const releases: number[] = [];
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["recovered"]);
    const firstResult = await primary.doStream(callOptions);
    const wrapped = wrapStreamResult({
      candidates: [resolved(primary, 0), resolved(survivor, 1)],
      firstResult,
      logicalId: "chat",
      onCandidateFailure: (candidate) => {
        candidate.fullIndex = 100;
      },
      onCandidateSuccess: (candidate) => {
        candidate.fullIndex = 101;
      },
      options: callOptions,
      releaseCandidate: (candidate) => releases.push(candidate.fullIndex),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({
      text: "recovered",
    });
    expect(releases).toEqual([0, 1]);
  });

  it("omits invalid candidate health transition hook results", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["recovered"]);
    const firstResult = await primary.doStream(callOptions);
    const transitions: unknown[] = [];
    let thenReads = 0;
    const invalidTransition = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("transition then extension must not run");
      },
    });
    const wrapped = wrapStreamResult({
      candidates: [resolved(primary, 0), resolved(survivor, 1)],
      firstResult,
      logicalId: "chat",
      onAttempt: ({ healthTransition }) => transitions.push(healthTransition),
      onCandidateFailure: () => "invalid-transition" as never,
      onCandidateSuccess: () => invalidTransition as never,
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({
      text: "recovered",
    });
    expect(transitions).toEqual([undefined, undefined]);
    expect(thenReads).toBe(0);
  });

  it("isolates read-only control hook candidate mutation", async () => {
    const releases: number[] = [];
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["recovered"]);
    const firstResult = await primary.doStream(callOptions);
    const wrapped = wrapStreamResult({
      acquireCandidate: (candidate) => {
        expect(candidate.fullIndex).toBe(1);
        candidate.fullIndex = 101;
        return 1;
      },
      candidateAvailable: (candidate) => {
        expect(candidate.fullIndex).toBe(1);
        candidate.fullIndex = 100;
        return true;
      },
      candidateInFlight: (candidate) => {
        candidate.fullIndex = 102;
        return 0;
      },
      candidates: [resolved(primary, 0), resolved(survivor, 1)],
      concurrencyLimit: (candidate) => {
        candidate.fullIndex = 103;
        return 1;
      },
      firstResult,
      logicalId: "chat",
      onAttempt: () => undefined,
      options: callOptions,
      releaseCandidate: (candidate) => releases.push(candidate.fullIndex),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({
      text: "recovered",
    });
    expect(survivor.doStreamCalls).toHaveLength(1);
    expect(releases).toEqual([0, 1]);
  });
});
