import { describe, expect, it } from "vitest";
import { errorPartModel, runFallback, textModel } from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("does not report a waited and admitted stream candidate as skipped", async () => {
    const events: Array<{
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["waited"])],
      {
        acquireCandidate: () => undefined,
        onAttempt: ({ index, outcome, reason }) =>
          events.push({ index, outcome, reason }),
        waitForCandidate: () => Promise.resolve(1),
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("waited");
    expect(events).toContainEqual({
      index: 1,
      outcome: "success",
      reason: undefined,
    });
    expect(events).not.toContainEqual({
      index: 1,
      outcome: "skipped",
      reason: "concurrency",
    });
  });

  it("reports a stream candidate as skipped when capacity waiting expires", async () => {
    const skipped: Array<{ index: number; reason?: string }> = [];
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["blocked"])],
      {
        acquireCandidate: () => undefined,
        onAttempt: ({ index, outcome, reason }) => {
          if (outcome === "skipped") {
            skipped.push({ index, reason });
          }
        },
        waitForCandidate: () => Promise.resolve(undefined),
      }
    );

    expect(out.error).toBeDefined();
    expect(skipped).toEqual([{ index: 1, reason: "concurrency" }]);
  });

  it("orders deferred stream skips after their triggering failure", async () => {
    const events: Array<{
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["saturated"]),
        textModel(["cooling"]),
        textModel(["waited"]),
      ],
      {
        acquireCandidate: () => undefined,
        candidateAvailable: ({ fullIndex }) => fullIndex !== 2,
        onAttempt: ({ index, outcome, reason }) =>
          events.push({ index, outcome, reason }),
        waitForCandidate: () => Promise.resolve(1),
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("waited");
    expect(events).toEqual([
      { index: 0, outcome: "failure", reason: undefined },
      { index: 1, outcome: "skipped", reason: "concurrency" },
      { index: 2, outcome: "skipped", reason: "cooldown" },
      { index: 3, outcome: "success", reason: undefined },
    ]);
  });

  it("isolates a throwing deferred skip hook from later events", async () => {
    const events: Array<{ index: number; outcome: string; reason?: string }> =
      [];
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["saturated"]),
        textModel(["cooling"]),
        textModel(["waited"]),
      ],
      {
        acquireCandidate: () => undefined,
        candidateAvailable: ({ fullIndex }) => fullIndex !== 2,
        onAttempt: ({ index, outcome, reason }) => {
          events.push({ index, outcome, reason });
          if (index === 1 && outcome === "skipped") {
            throw new Error("deferred metrics unavailable");
          }
        },
        waitForCandidate: () => Promise.resolve(1),
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("waited");
    expect(events).toEqual([
      { index: 0, outcome: "failure", reason: undefined },
      { index: 1, outcome: "skipped", reason: "concurrency" },
      { index: 2, outcome: "skipped", reason: "cooldown" },
      { index: 3, outcome: "success", reason: undefined },
    ]);
  });

  it("snapshots deferred concurrency metrics before admission state changes", async () => {
    let inFlight = 2;
    let limit = 2;
    const skipped: Array<{ inFlight?: number; limit?: number }> = [];
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["saturated"]),
        textModel(["waited"]),
      ],
      {
        acquireCandidate: () => undefined,
        candidateInFlight: () => inFlight,
        concurrencyLimit: () => limit,
        onAttempt: ({ concurrencyLimit, inFlight: seen, outcome }) => {
          if (outcome === "skipped") {
            skipped.push({ inFlight: seen, limit: concurrencyLimit });
          }
        },
        waitForCandidate: () => {
          inFlight = 0;
          limit = 1;
          return Promise.resolve(1);
        },
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("waited");
    expect(skipped).toEqual([{ inFlight: 2, limit: 2 }]);
  });

  it("orders max-attempt skips after the failure that exhausted the budget", async () => {
    const events: Array<{
      attempt?: number;
      index: number;
      outcome: string;
      reason?: string;
    }> = [];
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["second"]),
        textModel(["third"]),
      ],
      {
        maxAttempts: 1,
        onAttempt: ({ attempt, index, outcome, reason }) =>
          events.push({ attempt, index, outcome, reason }),
      }
    );

    expect(out.error).toMatchObject({ message: "primary failed" });
    expect(events).toEqual([
      {
        attempt: 1,
        index: 0,
        outcome: "failure",
        reason: undefined,
      },
      {
        attempt: undefined,
        index: 1,
        outcome: "skipped",
        reason: "max-attempts",
      },
      {
        attempt: undefined,
        index: 2,
        outcome: "skipped",
        reason: "max-attempts",
      },
    ]);
  });
});
