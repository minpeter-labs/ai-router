import { describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../admission";
import { AdmissionRegistry } from "../admission-utils";

describe("AdmissionController", () => {
  it("does not drain waiters above a newly reduced AIMD limit", async () => {
    const admission = new AdmissionController(
      [
        {
          adaptiveConcurrency: {
            initial: 4,
            max: 4,
            min: 1,
          },
        },
      ],
      1000
    );
    for (let index = 0; index < 4; index += 1) {
      expect(admission.acquire(0)).toBe(index + 1);
    }
    const settled: string[] = [];
    const first = admission.waitFor(0, undefined, undefined).then((slot) => {
      settled.push(`first:${slot}`);
      return slot;
    });
    const second = admission.waitFor(0, undefined, undefined).then((slot) => {
      settled.push(`second:${slot}`);
      return slot;
    });

    admission.observe(0, false, {
      retryable: true,
      scope: "transient",
      statusCode: 503,
    });
    expect(admission.limit(0)).toBe(2);

    admission.release(0);
    admission.release(0);
    await Promise.resolve();
    expect(admission.inFlight(0)).toBe(2);
    expect(settled).toEqual([]);

    admission.release(0);
    await expect(first).resolves.toBe(2);
    expect(settled).toEqual(["first:2"]);
    expect(admission.inFlight(0)).toBe(2);

    admission.release(0);
    await expect(second).resolves.toBe(2);
    expect(settled).toEqual(["first:2", "second:2"]);
    admission.release(0);
    admission.release(0);
  });

  it("does not admit a waiter on an unmatched release", async () => {
    vi.useFakeTimers();
    try {
      const admission = new AdmissionController([{ maxConcurrency: 1 }], 10);
      const waiting = admission.waitFor(0, undefined, undefined);

      admission.release(0);
      await vi.advanceTimersByTimeAsync(10);

      await expect(waiting).resolves.toBeUndefined();
      expect(admission.inFlight(0)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overflow a saturated in-flight counter", () => {
    const registry = new AdmissionRegistry();
    registry.inFlightCounts.set("default:unit:0", Number.MAX_SAFE_INTEGER);
    const admission = new AdmissionController(
      [{}],
      undefined,
      "default",
      registry
    );

    expect(admission.canAcquire(0)).toBe(false);
    expect(admission.acquire(0)).toBeUndefined();
    expect(admission.inFlight(0)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("fails open and repairs malformed shared in-flight counters", () => {
    for (const malformed of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const registry = new AdmissionRegistry();
      registry.inFlightCounts.set("default:unit:0", malformed);
      const admission = new AdmissionController(
        [{ maxConcurrency: 1 }],
        undefined,
        "default",
        registry
      );

      expect(admission.canAcquire(0)).toBe(true);
      expect(admission.acquire(0)).toBe(1);
      expect(admission.snapshot(0).inFlight).toBe(1);
      admission.release(0);
      expect(admission.inFlight(0)).toBe(0);
    }
  });

  it("preflights capacity after a pending release in the same scope", () => {
    const admission = new AdmissionController([
      { healthKey: "shared", maxConcurrency: 1 },
      { healthKey: "shared", maxConcurrency: 1 },
      { healthKey: "other", maxConcurrency: 1 },
    ]);
    expect(admission.acquire(0)).toBe(1);

    expect(admission.canAcquire(1)).toBe(false);
    expect(admission.canAcquireAfterRelease(1, 0)).toBe(true);
    expect(admission.canAcquireAfterRelease(2, 0)).toBe(true);
  });

  it("additively increases and halves an adaptive limit on rate limits", () => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          increaseAfterSuccesses: 2,
          initial: 2,
          max: 4,
          min: 1,
        },
      },
    ]);
    admission.observe(0, true);
    admission.observe(0, true);
    expect(admission.limit(0)).toBe(3);
    expect(admission.snapshot(0)).toMatchObject({
      adaptive: true,
      inFlight: 0,
      limit: 3,
      max: 4,
      min: 1,
      successes: 0,
      waiting: 0,
    });

    admission.observe(0, false, {
      retryable: true,
      scope: "credential",
      statusCode: 429,
    });
    expect(admission.limit(0)).toBe(1);
  });

  it.each([
    408, 425, 500, 503,
  ])("halves an adaptive limit on retryable congestion status %i", (statusCode) => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          initial: 8,
          max: 8,
          min: 1,
        },
      },
    ]);

    admission.observe(0, false, {
      retryable: true,
      scope: "transient",
      statusCode,
    });

    expect(admission.limit(0)).toBe(4);
  });

  it("does not halve adaptive capacity for non-congestion routing failures", () => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          initial: 8,
          max: 8,
          min: 1,
        },
      },
    ]);

    admission.observe(0, false, {
      retryable: true,
      scope: "routing-unit",
      statusCode: 404,
    });

    expect(admission.limit(0)).toBe(8);
  });

  it("ignores a stale success completed after a newer congestion failure", () => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          increaseAfterSuccesses: 1,
          initial: 8,
          max: 8,
          min: 1,
        },
      },
    ]);

    admission.observe(
      0,
      false,
      { retryable: true, scope: "transient", statusCode: 503 },
      20
    );
    admission.observe(0, true, undefined, 10);

    expect(admission.limit(0)).toBe(4);
    expect(admission.snapshot(0).successes).toBe(0);
  });
});
