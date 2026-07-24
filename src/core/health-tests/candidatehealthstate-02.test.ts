import { describe, expect, it } from "vitest";
import { CandidateHealthState } from "../candidate-health";
import { MemoryRouterHealthStore } from "../health-store";

describe("CandidateHealthState", () => {
  it("does not release a newer probe lease owned by another router", () => {
    let now = 0;
    const store = new MemoryRouterHealthStore();
    const state = new CandidateHealthState("chat", store, () => now);
    state.failure(0, { retryable: true, scope: "transient" });
    now = 15_001;

    expect(state.claimProbe(0)).toBe(true);
    const staleLease = state.takeProbeLease(0);
    const claimed = store.get("chat:unit:0");
    if (claimed === undefined) {
      throw new Error("expected claimed probe record");
    }
    store.set("chat:unit:0", {
      ...claimed,
      probingUntil: 60_000,
      version: (claimed.version ?? 0) + 1,
    });

    state.releaseProbe(staleLease);

    expect(store.get("chat:unit:0")).toMatchObject({
      probingUntil: 60_000,
      version: (claimed.version ?? 0) + 1,
    });
    expect(state.available(0)).toBe(false);
  });

  it("does not release a newer local lease owned by another router", () => {
    let now = 0;
    class ThrowingStore extends MemoryRouterHealthStore {
      override get(): never {
        throw new Error("store unavailable");
      }

      override compareAndSet(): never {
        throw new Error("store unavailable");
      }
    }
    const store = new ThrowingStore();
    const first = new CandidateHealthState("chat", store, () => now);
    const second = new CandidateHealthState("chat", store, () => now);
    first.failure(0, { retryable: true, scope: "transient" });
    now = 15_001;

    expect(first.claimProbe(0)).toBe(true);
    const staleLease = first.takeProbeLease(0);
    now = 45_002;
    expect(second.claimProbe(0)).toBe(true);

    first.releaseProbe(staleLease);

    expect(second.available(0)).toBe(false);
    expect(second.claimProbe(0)).toBe(false);
  });

  it("recomputes ordering guards after a CAS conflict", () => {
    class ConflictStore extends MemoryRouterHealthStore {
      private conflicted = false;

      override compareAndSet(
        key: string,
        expectedVersion: number | undefined,
        value: Parameters<MemoryRouterHealthStore["set"]>[1]
      ): boolean {
        if (!this.conflicted) {
          this.conflicted = true;
          this.set(key, {
            cooldownUntil: 0,
            failures: 0,
            lastSuccessAt: 200,
            version: (expectedVersion ?? 0) + 1,
          });
          return false;
        }
        return super.compareAndSet(key, expectedVersion, value);
      }
    }
    const store = new ConflictStore();
    const state = new CandidateHealthState("chat", store, () => 1000);

    expect(
      state.failure(
        0,
        { retryable: true, scope: "transient" },
        undefined,
        undefined,
        100
      )
    ).toBe("ignored-stale");
    expect(state.snapshot()).toEqual([]);
  });

  it("orders v1 timestamps numerically after they exceed fixed width", () => {
    const store = new MemoryRouterHealthStore();
    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 0,
      lastSuccessAt: "v1:9999999999999:z:000000",
      version: 1,
    });
    const state = new CandidateHealthState(
      "chat",
      store,
      () => 10_000_000_000_000
    );

    expect(
      state.failure(
        0,
        { retryable: true, scope: "transient" },
        undefined,
        undefined,
        "v1:10000000000000:a:000000"
      )
    ).toBe("cooling");
  });

  it("orders variable-width v1 timestamps exactly beyond safe integers", () => {
    const store = new MemoryRouterHealthStore();
    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 0,
      lastSuccessAt: "v1:9999999999999999:z:000000",
      version: 1,
    });
    const state = new CandidateHealthState(
      "chat",
      store,
      () => 10_000_000_000_000_000
    );

    expect(
      state.failure(
        0,
        { retryable: true, scope: "transient" },
        undefined,
        undefined,
        "v1:10000000000000000:a:000000"
      )
    ).toBe("cooling");
  });

  it("surfaces exhausted CAS retries without changing routing", () => {
    class ContendedStore extends MemoryRouterHealthStore {
      override compareAndSet(): boolean {
        return false;
      }
    }
    const state = new CandidateHealthState(
      "chat",
      new ContendedStore(),
      () => 1000
    );

    expect(state.failure(0, { retryable: true, scope: "transient" })).toBe(
      "cas-exhausted"
    );
    expect(state.success(0)).toBe("cas-exhausted");
  });

  it("retains a local recovery when a stale shared cooldown cannot be updated", () => {
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
    const observer = new CandidateHealthState("chat", store, () => 1000);

    expect(state.success(0, undefined, undefined, 20)).toBe("cas-exhausted");
    expect(state.available(0)).toBe(true);
    expect(observer.available(0)).toBe(true);
    expect(state.snapshot()).toEqual([]);
    expect(store.get("chat:unit:0")?.failures).toBe(1);
  });

  it("lets a newer shared failure supersede a contended local recovery", () => {
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
    expect(state.success(0, undefined, undefined, 20)).toBe("cas-exhausted");

    store.set("chat:unit:0", {
      cooldownUntil: 30_000,
      failures: 2,
      lastFailureAt: 30,
      observedAtMs: 1001,
      version: 2,
    });

    expect(state.available(0)).toBe(false);
    expect(state.snapshot()[0]?.record.lastFailureAt).toBe(30);
  });
});
