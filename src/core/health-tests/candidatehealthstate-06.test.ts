import { describe, expect, it } from "vitest";
import { CandidateHealthState } from "../candidate-health";
import { MemoryRouterHealthStore } from "../health-store";
import type { RouterHealthStore } from "../types";

describe("CandidateHealthState", () => {
  it("ignores malformed stored health records", () => {
    const store = new MemoryRouterHealthStore();
    store.set("chat:unit:0", {
      cooldownUntil: Number.POSITIVE_INFINITY,
      failures: -1,
    });
    const state = new CandidateHealthState("chat", store, () => 1000);

    expect(state.available(0)).toBe(true);
    expect(state.snapshot()).toEqual([]);

    let getterReads = 0;
    const hostile = Object.defineProperty(
      { cooldownUntil: 10_000, failures: 1 },
      "observedAtMs",
      {
        get() {
          getterReads += 1;
          throw new Error("record getter failed");
        },
      }
    );
    store.set("chat:unit:0", hostile as never);
    expect(state.available(0)).toBe(false);
    expect(getterReads).toBe(0);

    let ownKeyReads = 0;
    const bounded = new Proxy(
      { cooldownUntil: 10_000, failures: 1 },
      {
        ownKeys() {
          ownKeyReads += 1;
          throw new Error("record keys must not be enumerated");
        },
      }
    );
    expect(() => store.set("chat:unit:0", bounded)).not.toThrow();
    expect(state.available(0)).toBe(false);
    expect(ownKeyReads).toBe(0);

    store.set("chat:unit:0", {
      cooldownUntil: 10_000,
      failures: 1,
      lastFailureAt: "newer-than-everything",
    });
    expect(state.available(0)).toBe(true);

    store.set("chat:unit:0", {
      cooldownUntil: 10_000,
      failures: Number.MAX_SAFE_INTEGER + 1,
      version: Number.MAX_SAFE_INTEGER + 1,
    });
    expect(state.available(0)).toBe(true);
    expect(state.snapshot()).toEqual([]);

    store.set("chat:unit:0", { cooldownUntil: -1, failures: 1 });
    expect(state.available(0)).toBe(true);
    expect(state.snapshot()).toEqual([]);

    store.set("chat:unit:0", {
      cooldownUntil: 10_000,
      failures: 1,
      lastStatus: 99,
    });
    expect(state.available(0)).toBe(true);
    expect(state.snapshot()).toEqual([]);

    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 0,
      probingUntil: 10_000,
    });
    expect(state.available(0)).toBe(true);
    expect(state.snapshot()).toEqual([]);
  });

  it("fails open for shared cooldowns and probe leases too far in the future", () => {
    const now = 1_000_000;
    const store = new MemoryRouterHealthStore();
    const state = new CandidateHealthState("chat", store, () => now);

    store.set("chat:unit:0", {
      cooldownUntil: now + 3_900_001,
      failures: 1,
      observedAtMs: now,
    });
    expect(state.available(0)).toBe(true);
    expect(state.snapshot()).toEqual([]);

    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 1,
      observedAtMs: now,
      probingUntil: now + 330_001,
    });
    expect(state.available(0)).toBe(true);
    expect(state.claimProbe(0)).toBe(true);

    store.set("chat:unit:0", {
      cooldownUntil: now + 1000,
      failures: 1,
      observedAtMs: now + 300_001,
    });
    expect(state.available(0)).toBe(true);
  });

  it("fails open for v1 ordering tokens beyond clock skew", () => {
    const now = 1_700_000_000_000;
    const store = new MemoryRouterHealthStore();
    store.set("chat:unit:0", {
      cooldownUntil: now + 1000,
      failures: 1,
      lastFailureAt: "v1:1700000300001:remote00:000001",
      observedAtMs: now,
    });
    const state = new CandidateHealthState("chat", store, () => now);

    expect(state.available(0)).toBe(true);
    expect(state.snapshot()).toEqual([]);
  });

  it("honors maximum cooldown and probe leases within clock skew", () => {
    const now = 1_000_000;
    const store = new MemoryRouterHealthStore();
    const state = new CandidateHealthState("chat", store, () => now);

    store.set("chat:unit:0", {
      cooldownUntil: now + 3_900_000,
      failures: 1,
      observedAtMs: now + 300_000,
    });
    expect(state.available(0)).toBe(false);

    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 1,
      observedAtMs: now,
      probingUntil: now + 330_000,
    });
    expect(state.available(0)).toBe(false);
  });

  it("saturates the failure counter at the safe integer limit", () => {
    const store = new MemoryRouterHealthStore();
    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: Number.MAX_SAFE_INTEGER,
      version: 1,
    });
    const state = new CandidateHealthState("chat", store, () => 1000);

    state.failure(0, { retryable: true, scope: "transient" });

    expect(store.get("chat:unit:0")?.failures).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("does not corrupt a record when its CAS version is saturated", () => {
    const store = new MemoryRouterHealthStore();
    const saturated = {
      cooldownUntil: 0,
      failures: 1,
      version: Number.MAX_SAFE_INTEGER,
    };
    store.set("chat:unit:0", saturated);
    const state = new CandidateHealthState("chat", store, () => 1000);

    expect(state.claimProbe(0)).toBe(true);
    expect(state.failure(0, { retryable: true, scope: "transient" })).toBe(
      "cas-exhausted"
    );
    expect(store.get("chat:unit:0")).toEqual(saturated);
  });

  it("rejects async non-CAS writes without unhandled rejections", async () => {
    const store = {
      delete: () => undefined,
      get: () => undefined,
      set: () => Promise.reject(new Error("async set failed")),
    } as unknown as RouterHealthStore;
    const state = new CandidateHealthState("chat", store);

    expect(state.failure(0, { retryable: true, scope: "transient" })).toBe(
      "cas-exhausted"
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
