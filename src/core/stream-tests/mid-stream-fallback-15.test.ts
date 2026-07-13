import { describe, expect, it } from "vitest";
import { errorPartModel, runFallback, textModel } from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("bounds and completely flushes maximum-candidate skip observability", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const unattempted = textModel(["must not run"]);
    const models = Array.from({ length: 10_000 }, (_, index) =>
      index === 0 ? primary : unattempted
    );
    let events = 0;
    let rejectedHooks = 0;
    let finalEvent:
      | { attempt?: number; index: number; outcome: string; reason?: string }
      | undefined;

    const out = await runFallback(models, {
      maxAttempts: 1,
      onAttempt: ({ attempt, index, outcome, reason }) => {
        events += 1;
        finalEvent = { attempt, index, outcome, reason };
        if (index % 1000 === 0) {
          rejectedHooks += 1;
          return Promise.reject(new Error("sampled metrics rejection"));
        }
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(out.error).toMatchObject({ message: "primary failed" });
    expect(events).toBe(10_000);
    expect(rejectedHooks).toBe(10);
    expect(finalEvent).toEqual({
      attempt: undefined,
      index: 9999,
      outcome: "skipped",
      reason: "max-attempts",
    });
    expect(unattempted.doStreamCalls).toHaveLength(0);
  });

  it("reports post-output fallback skips as stream-mid", async () => {
    const phases: Array<string | undefined> = [];
    await runFallback(
      [
        errorPartModel(new Error("primary failed"), ["partial"]),
        textModel(["blocked"]),
      ],
      {
        acquireCandidate: () => undefined,
        onAttempt: ({ outcome, phase }) => {
          if (outcome === "skipped") {
            phases.push(phase);
          }
        },
        retryAfterOutput: true,
      }
    );

    expect(phases).toEqual(["stream-mid"]);
  });

  it("does not wait on a cooling final candidate", async () => {
    let waited = false;
    await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["cooling"])],
      {
        acquireCandidate: () => undefined,
        candidateAvailable: (candidate) => candidate.fullIndex !== 1,
        waitForCandidate: () => {
          waited = true;
          return Promise.resolve(1);
        },
      }
    );

    expect(waited).toBe(false);
  });

  it("releases a slot when health changes during admission", async () => {
    let available = true;
    const released: number[] = [];
    const releasedProbes: number[] = [];
    const secondary = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), secondary],
      {
        acquireCandidate: () => {
          available = false;
          return 1;
        },
        candidateAvailable: () => available,
        releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
      }
    );

    expect(out.error).toBeDefined();
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect(released).toContain(1);
    expect(releasedProbes).toContain(1);
  });

  it("releases acquired ownership when the post-admission health check throws", async () => {
    let availabilityReads = 0;
    const released: number[] = [];
    const releasedProbes: number[] = [];
    const secondary = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), secondary],
      {
        acquireCandidate: () => 1,
        candidateAvailable: () => {
          availabilityReads += 1;
          if (availabilityReads >= 3) {
            throw new Error("health recheck failed");
          }
          return true;
        },
        releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
      }
    );

    expect(out.error).toMatchObject({ message: "health recheck failed" });
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect(released).toContain(1);
    expect(releasedProbes).toContain(1);
  });

  it("releases a probe when health changes while waiting for capacity", async () => {
    let available = true;
    const released: number[] = [];
    const releasedProbes: number[] = [];
    const secondary = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), secondary],
      {
        acquireCandidate: () => undefined,
        candidateAvailable: () => available,
        releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
        waitForCandidate: () => {
          available = false;
          return Promise.resolve(1);
        },
      }
    );

    expect(out.error).toBeDefined();
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect(released).toContain(1);
    expect(releasedProbes).toContain(1);
  });

  it("claims a half-open probe only after capacity waiting succeeds", async () => {
    const order: string[] = [];
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["recovered"])],
      {
        acquireCandidate: () => undefined,
        prepareCandidate: () => {
          order.push("claim-probe");
          return true;
        },
        waitForCandidate: () => {
          order.push("wait-for-slot");
          return Promise.resolve(1);
        },
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(order).toEqual(["claim-probe", "wait-for-slot", "claim-probe"]);
  });

  it("releases waited ownership when probe preparation throws", async () => {
    let preparations = 0;
    const released: number[] = [];
    const releasedProbes: number[] = [];
    const secondary = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), secondary],
      {
        acquireCandidate: () => undefined,
        prepareCandidate: () => {
          preparations += 1;
          if (preparations === 2) {
            throw new Error("probe preparation failed");
          }
          return true;
        },
        releaseCandidate: ({ fullIndex }) => released.push(fullIndex),
        releaseProbeCandidate: ({ fullIndex }) =>
          releasedProbes.push(fullIndex),
        waitForCandidate: () => Promise.resolve(1),
      }
    );

    expect(out.error).toMatchObject({ message: "probe preparation failed" });
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect(released).toContain(1);
    expect(releasedProbes).toContain(1);
  });
});
