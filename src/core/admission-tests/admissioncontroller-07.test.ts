import { describe, expect, it } from "vitest";
import { AdmissionController } from "../admission";
import { AdmissionRegistry } from "../admission-utils";

describe("AdmissionController", () => {
  it("ignores a stale congestion failure completed after a newer success", () => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          increaseAfterSuccesses: 1,
          initial: 4,
          max: 8,
          min: 1,
        },
      },
    ]);

    admission.observe(0, true, undefined, 20);
    admission.observe(
      0,
      false,
      { retryable: true, scope: "transient", statusCode: 503 },
      10
    );

    expect(admission.limit(0)).toBe(5);
  });

  it("uses ordering tokens when concurrent outcomes share one start timestamp", () => {
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
    const older = "v1:0000000001000:source0000000000:000001";
    const newer = "v1:0000000001000:source0000000000:000002";

    admission.observe(
      0,
      false,
      { retryable: true, scope: "transient", statusCode: 503 },
      10,
      newer
    );
    admission.observe(0, true, undefined, 10, older);

    expect(admission.limit(0)).toBe(4);
    expect(admission.snapshot(0).successes).toBe(0);

    const rollover = new AdmissionController([
      {
        adaptiveConcurrency: {
          increaseAfterSuccesses: 1,
          initial: 8,
          max: 8,
          min: 1,
        },
      },
    ]);
    rollover.observe(
      0,
      false,
      { retryable: true, scope: "transient", statusCode: 503 },
      10,
      "v1:10000000000000:source0000000000:000000"
    );
    rollover.observe(
      0,
      true,
      undefined,
      10,
      "v1:9999999999999:source0000000000:999999"
    );
    expect(rollover.limit(0)).toBe(4);
  });

  it("does not reset AIMD progress for request-scoped failures", () => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          increaseAfterSuccesses: 2,
          initial: 1,
          max: 2,
          min: 1,
        },
      },
    ]);
    admission.observe(0, true);
    admission.observe(0, false, { retryable: false, scope: "request" });
    admission.observe(0, true);

    expect(admission.limit(0)).toBe(2);
  });

  it("rebuilds malformed shared adaptive state", () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [
        {
          adaptiveConcurrency: {
            increaseAfterSuccesses: 2,
            initial: 1,
            max: 4,
            min: 1,
          },
        },
      ],
      undefined,
      "default",
      registry
    );
    expect(admission.limit(0)).toBe(1);
    const state = registry.adaptiveStates.get("default:unit:0");
    expect(state).toBeDefined();
    if (state !== undefined) {
      state.limit = Number.NaN;
      state.successes = -1;
    }

    expect(admission.limit(0)).toBe(1);
    expect(admission.snapshot(0)).toMatchObject({
      limit: 1,
      successes: 0,
    });
  });

  it("snapshots hostile adaptive state once and rebuilds unreadable state", () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ adaptiveConcurrency: { initial: 2, max: 4, min: 1 } }],
      undefined,
      "default",
      registry
    );
    const reads = new Map<string, number>();
    const state = new Proxy(
      {
        increaseAfterSuccesses: 3,
        limit: 2,
        max: 4,
        min: 1,
        successes: 1,
      },
      {
        get(target, key, receiver) {
          if (typeof key === "string") {
            reads.set(key, (reads.get(key) ?? 0) + 1);
          }
          return Reflect.get(target, key, receiver);
        },
      }
    );
    registry.adaptiveStates.set("default:unit:0", state);

    expect(admission.snapshot(0)).toMatchObject({ limit: 2, successes: 1 });
    expect([...reads.values()]).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(registry.adaptiveStates.get("default:unit:0")).not.toBe(state);

    registry.adaptiveStates.set(
      "default:unit:0",
      new Proxy(state, {
        get() {
          throw new Error("adaptive state unavailable");
        },
      })
    );
    expect(() => admission.snapshot(0)).not.toThrow();
    expect(admission.snapshot(0)).toMatchObject({ limit: 2, successes: 0 });
  });

  it("orders by current load and rotates round-robin candidates", () => {
    const admission = new AdmissionController([
      { maxConcurrency: 2 },
      { maxConcurrency: 2 },
      { maxConcurrency: 2 },
    ]);
    admission.acquire(0);
    const leastLoaded = [{ fullIndex: 0 }, { fullIndex: 1 }];
    admission.reorder(leastLoaded, "least-inflight");
    expect(leastLoaded.map(({ fullIndex }) => fullIndex)).toEqual([1, 0]);

    const first = [{ fullIndex: 0 }, { fullIndex: 1 }, { fullIndex: 2 }];
    const second = [{ fullIndex: 0 }, { fullIndex: 1 }, { fullIndex: 2 }];
    admission.reorder(first, "round-robin");
    admission.reorder(second, "round-robin");
    expect(first.map(({ fullIndex }) => fullIndex)).toEqual([0, 1, 2]);
    expect(second.map(({ fullIndex }) => fullIndex)).toEqual([1, 2, 0]);
  });

  it("keeps independent round-robin cursors for filtered candidate pools", () => {
    const admission = new AdmissionController([{}, {}, {}]);
    const firstPool = [{ fullIndex: 0 }, { fullIndex: 2 }];
    const otherPool = [{ fullIndex: 1 }, { fullIndex: 2 }];
    const firstPoolAgain = [{ fullIndex: 0 }, { fullIndex: 2 }];

    admission.reorder(firstPool, "round-robin");
    admission.reorder(otherPool, "round-robin");
    admission.reorder(firstPoolAgain, "round-robin");

    expect(firstPool.map(({ fullIndex }) => fullIndex)).toEqual([0, 2]);
    expect(otherPool.map(({ fullIndex }) => fullIndex)).toEqual([1, 2]);
    expect(firstPoolAgain.map(({ fullIndex }) => fullIndex)).toEqual([2, 0]);
  });
});
