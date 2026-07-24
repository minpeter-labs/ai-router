import { describe, expect, it } from "vitest";
import { errorPartModel, runFallback, textModel } from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("releases a probe when capacity waiting rejects", async () => {
    const releasedProbes: number[] = [];
    const outcomes: [boolean, boolean, boolean][] = [];
    const attempts: Array<{
      attempt?: number;
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["blocked"])],
      {
        acquireCandidate: () => undefined,
        isBudgetFailure: () => true,
        onRequestOutcome: (success, eligible, suppressed) =>
          outcomes.push([success, eligible, suppressed]),
        onAttempt: ({ attempt, index, outcome, reason }) =>
          attempts.push({ attempt, index, outcome, reason }),
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
        waitForCandidate: () => Promise.reject(new Error("wait aborted")),
      }
    );

    expect(out.error).toMatchObject({ message: "wait aborted" });
    expect(releasedProbes).toEqual([0, 1]);
    expect(outcomes).toEqual([[false, true, true]]);
    expect(attempts).toEqual([
      {
        attempt: 1,
        index: 0,
        outcome: "failure",
        reason: undefined,
      },
    ]);
  });

  it("keeps earlier capacity skips when the final wait infrastructure rejects", async () => {
    const attempts: Array<{
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["earlier blocked"]),
        textModel(["wait failed"]),
      ],
      {
        acquireCandidate: () => undefined,
        onAttempt: ({ index, outcome, reason }) =>
          attempts.push({ index, outcome, reason }),
        waitForCandidate: () =>
          Promise.reject(new Error("wait infrastructure failed")),
      }
    );

    expect(out.error).toMatchObject({ message: "wait infrastructure failed" });
    expect(attempts).toEqual([
      { index: 0, outcome: "failure", reason: undefined },
      { index: 1, outcome: "skipped", reason: "concurrency" },
    ]);
  });

  it("does not execute arbitrary admission wait thenable extensions", async () => {
    let thenReads = 0;
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["blocked"])],
      {
        acquireCandidate: () => undefined,
        waitForCandidate: () =>
          Object.defineProperty({}, ["th", "en"].join(""), {
            get() {
              thenReads += 1;
              throw new Error("then extension must not run");
            },
          }) as never,
      }
    );

    expect(out.error).toMatchObject({
      message: "ai-router: admission wait hook must return a genuine Promise",
    });
    expect(thenReads).toBe(0);
  });

  it("rejects malformed admission wait in-flight counts", async () => {
    const survivor = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: () => undefined,
        waitForCandidate: () => Promise.resolve(0),
      }
    );

    expect(out.error).toMatchObject({
      message:
        "ai-router: admission wait hook must resolve to a positive safe in-flight count or undefined",
    });
    expect(survivor.doStreamCalls).toHaveLength(0);
  });

  it("rejects malformed immediate admission in-flight counts", async () => {
    const survivor = textModel(["must not run"]);
    const releasedProbes: number[] = [];
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: () => Number.POSITIVE_INFINITY,
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
      }
    );

    expect(out.error).toMatchObject({
      message:
        "ai-router: admission acquire hook must return a positive safe in-flight count or undefined",
    });
    expect(survivor.doStreamCalls).toHaveLength(0);
    expect(releasedProbes).toEqual([0, 1]);
  });

  it("releases a prepared probe when admission acquire throws", async () => {
    const releasedProbes: number[] = [];
    const survivor = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: () => {
          throw new Error("acquire failed");
        },
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
      }
    );

    expect(out.error).toMatchObject({ message: "acquire failed" });
    expect(survivor.doStreamCalls).toHaveLength(0);
    expect(releasedProbes).toEqual([0, 1]);
  });
});
