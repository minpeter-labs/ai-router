import { describe, expect, it, vi } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import { wrapStreamResult } from "../stream";
import {
  callOptions,
  drive,
  errorPartModel,
  resolved,
  runFallback,
  textModel,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("passes a clean single stream through unchanged", async () => {
    const out = await runFallback([textModel(["Hello", ", world!"])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("Hello, world!");
  });

  it("uses valid monotonic attempt tokens without a caller token source", async () => {
    const candidates = [
      resolved(errorPartModel(new Error("first failed")), 0),
      resolved(errorPartModel(new Error("second failed")), 1),
      resolved(textModel(["ok"]), 2),
    ];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const tokens: string[] = [];
    const now = vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    try {
      const wrapped = wrapStreamResult({
        candidates,
        firstResult,
        logicalId: "chat",
        onCandidateFailure: (_candidate, _failure, token) => {
          tokens.push(String(token));
          return;
        },
        onCandidateSuccess: (_candidate, token) => {
          tokens.push(String(token));
          return;
        },
        options: callOptions,
        retryAfterOutput: false,
        shouldRetry: defaultShouldRetryThisError,
        startIndex: 0,
      });

      await expect(drive(wrapped.stream)).resolves.toMatchObject({
        text: "ok",
      });
      expect(tokens).toHaveLength(3);
      expect(tokens.every((token) => token.split(":").length === 4)).toBe(true);
      expect(tokens[0] < tokens[1]).toBe(true);
      expect(tokens[1] < tokens[2]).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("falls back to local tokens when a caller token source is hostile", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["ok"]);
    const candidates = [resolved(primary, 0), resolved(survivor, 1)];
    const firstResult = await primary.doStream(callOptions);
    const observedTokens: string[] = [];
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      nextOrderingToken: () => {
        throw new Error("token source failed");
      },
      onCandidateFailure: (_candidate, _failure, token) => {
        observedTokens.push(String(token));
        return;
      },
      onCandidateSuccess: (_candidate, token) => {
        observedTokens.push(String(token));
        return;
      },
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
      startOrderingToken: Number.NaN,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(survivor.doStreamCalls).toHaveLength(1);
    expect(observedTokens).toHaveLength(2);
    expect(observedTokens.every((token) => token.split(":").length === 4)).toBe(
      true
    );
  });

  it("isolates capacity and probe cleanup failures during fallback", async () => {
    const candidates = [
      resolved(errorPartModel(new Error("primary failed")), 0),
      resolved(textModel(["ok"]), 1),
    ];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const capacityReleases: number[] = [];
    const probeReleases: number[] = [];
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      releaseCandidate: ({ fullIndex }) => {
        capacityReleases.push(fullIndex);
        throw new Error("capacity cleanup failed");
      },
      releaseProbeCandidate: ({ fullIndex }) => {
        probeReleases.push(fullIndex);
        throw new Error("probe cleanup failed");
      },
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(capacityReleases).toEqual([0, 1]);
    expect(probeReleases).toEqual([0, 1]);
  });

  it("consumes async capacity and probe cleanup results without probing thenables", async () => {
    const model = textModel(["ok"]);
    const firstResult = await model.doStream(callOptions);
    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    const wrapped = wrapStreamResult({
      candidates: [resolved(model)],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      releaseCandidate: (() =>
        Promise.reject(new Error("async capacity release"))) as never,
      releaseProbeCandidate: (() => thenable) as never,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("isolates optional state hook failures from stream fallback", async () => {
    const candidates = [
      resolved(errorPartModel(new Error("primary failed")), 0),
      resolved(textModel(["ok"]), 1),
    ];
    const firstResult = await candidates[0].model.doStream(callOptions);
    const calls: string[] = [];
    const fail = (name: string): never => {
      calls.push(name);
      throw new Error(`${name} failed`);
    };
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      isBudgetFailure: () => fail("budget-classification"),
      logicalId: "chat",
      onAdvance: () => fail("cooldown-advance"),
      onCandidateFailure: () => fail("health-failure"),
      onCandidateSuccess: () => fail("health-success"),
      onRequestOutcome: () => fail("budget-outcome"),
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({
      error: undefined,
      text: "ok",
    });
    expect(calls).toEqual([
      "budget-classification",
      "health-failure",
      "cooldown-advance",
      "health-success",
      "budget-outcome",
    ]);
  });
});
