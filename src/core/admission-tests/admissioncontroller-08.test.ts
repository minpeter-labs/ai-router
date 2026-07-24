import { describe, expect, it } from "vitest";
import { AdmissionController } from "../admission";

describe("AdmissionController", () => {
  it("bounds retained round-robin pools and resets an evicted cursor", () => {
    const admission = new AdmissionController(
      Array.from({ length: 12 }, () => ({}))
    );
    const firstPool = [{ fullIndex: 0 }, { fullIndex: 1 }];
    admission.reorder(firstPool, "round-robin");

    let generated = 0;
    for (let mask = 1; generated < 1024; mask++) {
      const pool = Array.from({ length: 12 }, (_, index) => index)
        .filter((index) => Math.floor(mask / 2 ** index) % 2 !== 0)
        .map((fullIndex) => ({ fullIndex }));
      if (
        pool.length < 2 ||
        (pool.length === 2 &&
          pool[0]?.fullIndex === 0 &&
          pool[1]?.fullIndex === 1)
      ) {
        continue;
      }
      admission.reorder(pool, "round-robin");
      generated += 1;
    }

    const firstPoolAfterEviction = [{ fullIndex: 0 }, { fullIndex: 1 }];
    admission.reorder(firstPoolAfterEviction, "round-robin");
    expect(firstPoolAfterEviction.map(({ fullIndex }) => fullIndex)).toEqual([
      0, 1,
    ]);
  });

  it("uses exact bounded round-robin identities for maximum-size pools", () => {
    const admission = new AdmissionController(
      Array.from({ length: 10_000 }, () => ({}))
    );
    const first = Array.from({ length: 10_000 }, (_, fullIndex) => ({
      fullIndex,
    }));
    const second = Array.from({ length: 10_000 }, (_, fullIndex) => ({
      fullIndex,
    }));

    admission.reorder(first, "round-robin");
    admission.reorder(second, "round-robin");

    expect(first[0]?.fullIndex).toBe(0);
    expect(second[0]?.fullIndex).toBe(1);
    const cursors = (
      admission as unknown as {
        roundRobinCursors: Map<string, number>;
      }
    ).roundRobinCursors;
    expect(cursors.size).toBe(1);
    const [identity] = cursors.keys();
    expect(identity?.startsWith("0,1,2,3,4,5")).toBe(true);
    expect(identity?.endsWith("9997,9998,9999")).toBe(true);
    expect(identity?.length).toBeLessThan(50_000);
  });

  it("bounds aggregate exact round-robin identity retention", () => {
    const admission = new AdmissionController(
      Array.from({ length: 10_000 }, () => ({}))
    );

    for (let omitted = 0; omitted < 24; omitted += 1) {
      const pool = Array.from({ length: 10_000 }, (_, fullIndex) => ({
        fullIndex,
      })).filter(({ fullIndex }) => fullIndex !== omitted);
      admission.reorder(pool, "round-robin");
    }

    const state = admission as unknown as {
      roundRobinCursors: Map<string, number>;
      roundRobinPoolKeyChars: number;
    };
    expect(state.roundRobinPoolKeyChars).toBeLessThanOrEqual(1_048_576);
    expect(state.roundRobinCursors.size).toBeLessThan(24);
  });
});
