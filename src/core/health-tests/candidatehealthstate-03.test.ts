import { describe, expect, it } from "vitest";
import { CandidateHealthState } from "../candidate-health";
import { MemoryRouterHealthStore } from "../health-store";

describe("CandidateHealthState", () => {
  it("does not let an older failure overwrite a contended local recovery", () => {
    class RecoveryWriteContendedStore extends MemoryRouterHealthStore {
      override compareAndSet(): boolean {
        return false;
      }
    }
    const store = new RecoveryWriteContendedStore();
    store.set("chat:unit:0", {
      cooldownUntil: 20_000,
      failures: 1,
      lastFailureAt: 10,
      observedAtMs: 1000,
      version: 1,
    });
    const state = new CandidateHealthState("chat", store, () => 1000);
    expect(state.success(0, undefined, undefined, 30)).toBe("cas-exhausted");

    expect(
      state.failure(
        0,
        { retryable: true, scope: "transient" },
        undefined,
        undefined,
        20
      )
    ).toBe("ignored-stale");
    expect(state.available(0)).toBe(true);
    expect(state.snapshot()).toEqual([]);
  });

  it("rejects a malformed synchronous CAS result without retrying it", () => {
    let calls = 0;
    class MalformedStore extends MemoryRouterHealthStore {
      override compareAndSet(): boolean {
        calls += 1;
        return "yes" as never;
      }
    }
    const state = new CandidateHealthState(
      "chat",
      new MalformedStore(),
      () => 1000
    );

    expect(state.failure(0, { retryable: true, scope: "transient" })).toBe(
      "cas-exhausted"
    );
    expect(calls).toBe(1);
  });

  it("retains a local cooldown when an optional shared health store throws", () => {
    class ThrowingStore extends MemoryRouterHealthStore {
      override get(): never {
        throw new Error("store unavailable");
      }

      override set(): never {
        throw new Error("store unavailable");
      }

      override compareAndSet(): never {
        throw new Error("store unavailable");
      }

      override entries(): never {
        throw new Error("store unavailable");
      }
    }
    const state = new CandidateHealthState("chat", new ThrowingStore());

    expect(state.available(0)).toBe(true);
    expect(state.failure(0, { retryable: true, scope: "transient" })).toBe(
      "cas-exhausted"
    );
    expect(state.available(0)).toBe(false);
    const snapshot = state.snapshot();
    expect(snapshot).toHaveLength(1);
    snapshot[0].record.failures = 0;
    expect(state.snapshot()[0].record.failures).toBe(1);
    expect(state.success(0)).toBe("cas-exhausted");
    expect(state.available(0)).toBe(true);
    expect(state.snapshot()).toEqual([]);
  });

  it("does not clear a local write-failure cooldown with an older success", () => {
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

    expect(
      state.failure(
        0,
        { retryable: true, scope: "transient" },
        undefined,
        undefined,
        20
      )
    ).toBe("cas-exhausted");
    expect(state.success(0, undefined, undefined, 10)).toBe("ignored-stale");
    expect(state.available(0)).toBe(false);
    expect(state.success(0, undefined, undefined, 30)).toBe("cas-exhausted");
    expect(state.available(0)).toBe(true);
  });

  it("permits only one local half-open probe while the shared store is down", () => {
    let now = 1000;
    class ThrowingStore extends MemoryRouterHealthStore {
      override get(): never {
        throw new Error("store unavailable");
      }

      override compareAndSet(): never {
        throw new Error("store unavailable");
      }
    }
    const store = new ThrowingStore();
    const state = new CandidateHealthState("chat", store, () => now);
    const concurrent = new CandidateHealthState("chat", store, () => now);
    state.failure(0, { retryable: true, scope: "transient" });
    now += 15_001;

    expect(state.available(0)).toBe(true);
    expect(state.claimProbe(0)).toBe(true);
    expect(concurrent.claimProbe(0)).toBe(false);
    const lease = state.takeProbeLease(0);
    expect(lease?.source).toBe("local");
    expect(state.available(0)).toBe(false);
    state.releaseProbe(lease);
    expect(state.available(0)).toBe(true);
    expect(state.claimProbe(0)).toBe(true);
  });

  it("coordinates one local probe when shared lease CAS throws after a readable failure", () => {
    class LeaseWriteThrowingStore extends MemoryRouterHealthStore {
      override compareAndSet(): never {
        throw new Error("lease writes unavailable");
      }
    }
    const store = new LeaseWriteThrowingStore();
    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 1,
      lastFailureAt: 10,
      observedAtMs: 1000,
      version: 1,
    });
    const first = new CandidateHealthState("chat", store, () => 1000);
    const second = new CandidateHealthState("chat", store, () => 1000);

    expect(first.claimProbe(0)).toBe(true);
    expect(second.claimProbe(0)).toBe(false);
    const lease = first.takeProbeLease(0);
    expect(lease).toMatchObject({ source: "local" });
    expect(store.get("chat:unit:0")?.probingUntil).toBeUndefined();

    first.releaseProbe(lease);
    expect(second.claimProbe(0)).toBe(true);
  });

  it("coordinates one local probe for a malformed shared lease write result", () => {
    class MalformedLeaseStore extends MemoryRouterHealthStore {
      override compareAndSet(): boolean {
        return "yes" as never;
      }
    }
    const store = new MalformedLeaseStore();
    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 1,
      lastFailureAt: 10,
      observedAtMs: 1000,
      version: 1,
    });
    const first = new CandidateHealthState("chat", store, () => 1000);
    const second = new CandidateHealthState("chat", store, () => 1000);

    expect(first.claimProbe(0)).toBe(true);
    expect(second.claimProbe(0)).toBe(false);
    expect(first.takeProbeLease(0)).toMatchObject({ source: "local" });
  });
});
