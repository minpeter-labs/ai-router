import { describe, expect, it } from "vitest";
import { CandidateHealthState } from "../candidate-health";
import { MemoryRouterHealthStore } from "../health-store";
import type { RouterHealthRecord } from "../types";

describe("CandidateHealthState", () => {
  it("never releases a local-origin lease through a recovered shared store", () => {
    let now = 1000;
    let unavailable = true;
    class RecoveringStore extends MemoryRouterHealthStore {
      override get(key: string) {
        if (unavailable) {
          throw new Error("store unavailable");
        }
        return super.get(key);
      }

      override compareAndSet(
        key: string,
        expectedVersion: number | undefined,
        value: RouterHealthRecord
      ) {
        if (unavailable) {
          throw new Error("store unavailable");
        }
        return super.compareAndSet(key, expectedVersion, value);
      }
    }
    const store = new RecoveringStore();
    const state = new CandidateHealthState("chat", store, () => now);
    state.failure(0, { retryable: true, scope: "transient" });
    now += 15_001;
    expect(state.claimProbe(0)).toBe(true);
    const lease = state.takeProbeLease(0);
    if (lease === undefined) {
      throw new Error("expected local lease");
    }

    unavailable = false;
    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 1,
      probingUntil: lease.probingUntil,
      version: 1,
    });
    state.releaseProbe(lease);

    expect(store.get("chat:unit:0")?.probingUntil).toBe(lease.probingUntil);
  });

  it("reconciles a local cooldown with a newer same-clock shared recovery", () => {
    let unavailable = true;
    class RecoveringStore extends MemoryRouterHealthStore {
      override get(key: string) {
        if (unavailable) {
          throw new Error("store unavailable");
        }
        return super.get(key);
      }

      override compareAndSet(
        key: string,
        expectedVersion: number | undefined,
        value: RouterHealthRecord
      ) {
        if (unavailable) {
          throw new Error("store unavailable");
        }
        return super.compareAndSet(key, expectedVersion, value);
      }
    }
    const store = new RecoveringStore();
    const state = new CandidateHealthState("chat", store, () => 1000);
    state.failure(
      0,
      { retryable: true, scope: "transient" },
      undefined,
      undefined,
      20
    );
    unavailable = false;
    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 0,
      lastSuccessAt: 30,
      observedAtMs: 1000,
      version: 1,
    });

    expect(state.available(0)).toBe(true);
    expect(state.snapshot()).toEqual([]);
  });

  it("drops a pending local probe handoff after shared recovery", () => {
    let now = 1000;
    let unavailable = true;
    class RecoveringStore extends MemoryRouterHealthStore {
      override get(key: string) {
        if (unavailable) {
          throw new Error("store unavailable");
        }
        return super.get(key);
      }

      override compareAndSet(
        key: string,
        expectedVersion: number | undefined,
        value: RouterHealthRecord
      ) {
        if (unavailable) {
          throw new Error("store unavailable");
        }
        return super.compareAndSet(key, expectedVersion, value);
      }
    }
    const store = new RecoveringStore();
    const state = new CandidateHealthState("chat", store, () => now);
    const observer = new CandidateHealthState("chat", store, () => now);
    state.failure(
      0,
      { retryable: true, scope: "transient" },
      undefined,
      undefined,
      10
    );
    now += 15_001;
    expect(state.claimProbe(0)).toBe(true);

    unavailable = false;
    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 0,
      lastSuccessAt: 20,
      observedAtMs: now,
      version: 1,
    });

    expect(observer.available(0)).toBe(true);
    expect(state.takeProbeLease(0)).toBeUndefined();
  });

  it("bounds store-scoped local write-failure retention with LRU eviction", () => {
    class ThrowingStore extends MemoryRouterHealthStore {
      override get(): never {
        throw new Error("store unavailable");
      }

      override compareAndSet(): never {
        throw new Error("store unavailable");
      }
    }
    const state = new CandidateHealthState(
      "chat",
      new ThrowingStore(),
      () => 1000
    );

    for (let index = 0; index <= 100_000; index += 1) {
      state.failure(index, { retryable: true, scope: "transient" });
    }

    const retained = (
      state as unknown as {
        localWriteFailures: Map<string, unknown>;
      }
    ).localWriteFailures;
    expect(retained.size).toBe(100_000);
    expect(retained.has("chat:unit:0")).toBe(false);
    expect(retained.has("chat:unit:100000")).toBe(true);
  });
});
