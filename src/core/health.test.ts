import { describe, expect, it } from "vitest";
import { CandidateHealthState, MemoryRouterHealthStore } from "./health";
import type { RouterHealthRecord, RouterHealthStore } from "./types";

describe("CandidateHealthState", () => {
  it("bounds the in-memory shared store with LRU eviction", () => {
    const store = new MemoryRouterHealthStore(2);
    const record = { cooldownUntil: 0, failures: 0 };
    store.set("first", record);
    store.set("second", record);
    expect(store.get("first")).toEqual(record);
    store.set("third", record);

    expect(store.get("first")).toEqual(record);
    expect(store.get("second")).toBeUndefined();
    expect(store.get("third")).toEqual(record);
    expect(() => new MemoryRouterHealthStore(0)).toThrow("maxRecords");
  });

  it("isolates stored health records from caller mutation", () => {
    const store = new MemoryRouterHealthStore();
    const input = { cooldownUntil: 100, failures: 1, version: 1 };
    store.set("candidate", input);

    input.cooldownUntil = 999;
    const firstRead = store.get("candidate");
    expect(firstRead).toEqual({
      cooldownUntil: 100,
      failures: 1,
      version: 1,
    });

    if (firstRead !== undefined) {
      firstRead.failures = 99;
    }
    const entry = store.entries().next().value;
    if (entry !== undefined) {
      entry[1].version = 99;
    }

    expect(store.get("candidate")).toEqual({
      cooldownUntil: 100,
      failures: 1,
      version: 1,
    });
  });

  it("snapshots entry structure before LRU refresh or later writes", () => {
    const store = new MemoryRouterHealthStore();
    const record = { cooldownUntil: 0, failures: 0 };
    store.set("first", record);
    store.set("second", record);
    const entries = store.entries();

    expect(entries.next().value?.[0]).toBe("first");
    store.get("first");
    store.set("third", record);

    expect(entries.next().value?.[0]).toBe("second");
    expect(entries.next().done).toBe(true);
  });

  it("reports recovery only when success clears prior unhealthy state", () => {
    let now = 0;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );

    expect(state.success(0)).toBeUndefined();
    now = 1;
    state.failure(0, { retryable: true, scope: "transient" });
    now = 15_002;
    expect(state.success(0)).toBe("recovered");
    expect(state.success(0)).toBeUndefined();
  });

  it("does not recover from an incomparable same-ms distributed success", () => {
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => 1000
    );
    state.failure(
      0,
      { retryable: true, scope: "transient" },
      undefined,
      undefined,
      "v1:0000000001000:aaaa:000001"
    );

    expect(
      state.success(0, undefined, undefined, "v1:0000000001000:zzzz:999999")
    ).toBe("ignored-stale");
    expect(state.snapshot()[0].record.failures).toBe(1);

    expect(
      state.success(0, undefined, undefined, "v1:0000000001001:bbbb:000000")
    ).toBe("recovered");
    expect(state.snapshot()).toEqual([]);
  });

  it("does not let an incomparable same-ms success suppress a failure", () => {
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => 1000
    );
    state.success(0, undefined, undefined, "v1:0000000001000:zzzz:999999");

    expect(
      state.failure(
        0,
        { retryable: true, scope: "transient" },
        undefined,
        undefined,
        "v1:0000000001000:aaaa:000001"
      )
    ).toBe("cooling");
    expect(state.snapshot()[0].record.failures).toBe(1);
  });

  it("treats an incomparable same-ms remote failure as post-selection", () => {
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => 1000
    );
    state.failure(
      0,
      { retryable: true, scope: "transient" },
      undefined,
      undefined,
      "v1:0000000001000:aaaa:000001"
    );

    expect(
      state.unavailableSince(
        0,
        "v1:0000000001000:zzzz:999999",
        undefined,
        undefined
      )
    ).toBe(true);
  });

  it("honors cooldowns and permits only one half-open probe", () => {
    let now = 1000;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );
    state.failure(0, { retryable: true, scope: "transient" });
    expect(state.available(0)).toBe(false);
    expect(state.probe(0)).toBe(false);

    now += 15_001;
    expect(state.available(0)).toBe(true);
    expect(state.claimProbe(0)).toBe(true);
    expect(state.claimProbe(0)).toBe(false);
  });

  it("atomically grants a shared half-open lease to one router", () => {
    let now = 0;
    const store = new MemoryRouterHealthStore();
    const first = new CandidateHealthState("chat", store, () => now);
    const second = new CandidateHealthState("chat", store, () => now);
    first.failure(0, { retryable: true, scope: "transient" });
    now = 15_001;

    expect(first.available(0)).toBe(true);
    expect(first.claimProbe(0)).toBe(true);
    expect(second.claimProbe(0)).toBe(false);
  });

  it("conditionally releases an owned probe that never reached a provider", () => {
    let now = 0;
    const store = new MemoryRouterHealthStore();
    const state = new CandidateHealthState("chat", store, () => now);
    state.failure(0, { retryable: true, scope: "transient" });
    now = 15_001;

    expect(state.claimProbe(0)).toBe(true);
    const lease = state.takeProbeLease(0);
    expect(state.available(0)).toBe(false);
    state.releaseProbe(lease);

    expect(state.available(0)).toBe(true);
    expect(state.claimProbe(0)).toBe(true);
  });

  it("drops an expired untaken local lease before handing off a newer scope", () => {
    let now = 0;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );
    state.failure(0, { retryable: true, scope: "transient" }, "credential");
    now = 15_001;
    expect(state.claimProbe(0, "credential")).toBe(true);

    now = 45_002;
    state.failure(0, { retryable: true, scope: "credential" }, "credential");
    now = 165_003;
    expect(state.claimProbe(0, "credential")).toBe(true);

    expect(state.takeProbeLease(0, "credential")?.key).toBe(
      "chat:credential:credential"
    );
  });

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

  it("does not evict an active local probe at the overlay LRU boundary", () => {
    let now = 1000;
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
      () => now
    );
    for (let index = 0; index < 100_000; index += 1) {
      state.failure(index, { retryable: true, scope: "transient" });
    }
    now += 15_001;
    expect(state.claimProbe(0)).toBe(true);
    const retained = state as unknown as {
      inactiveLocalWriteFailures: Map<string, true>;
      localProbeExpirations: Array<{ deadline: number; key: string }>;
      localWriteFailures: Map<string, RouterHealthRecord>;
    };
    const inactive = retained.inactiveLocalWriteFailures;
    const records = retained.localWriteFailures;
    const active = records.get("chat:unit:0");
    if (active === undefined) {
      throw new Error("expected active local probe");
    }
    const others = [...records].filter(([key]) => key !== "chat:unit:0");
    records.clear();
    records.set("chat:unit:0", active);
    for (const [key, record] of others) {
      records.set(key, record);
    }

    state.failure(100_000, { retryable: true, scope: "transient" });

    expect(records.size).toBe(100_000);
    expect(records.has("chat:unit:0")).toBe(true);
    expect(records.has("chat:unit:1")).toBe(false);
    expect(inactive.has("chat:unit:0")).toBe(false);
    expect(state.available(0)).toBe(false);

    retained.localProbeExpirations.length = 0;
    for (const [key, record] of records) {
      const probingUntil = now + 30_000;
      records.set(key, { ...record, probingUntil });
      retained.localProbeExpirations.push({ deadline: probingUntil, key });
    }
    inactive.clear();
    state.failure(100_001, { retryable: true, scope: "transient" });
    expect(records.size).toBe(100_000);
    expect(records.has("chat:unit:100001")).toBe(false);

    now += 30_001;
    state.failure(100_002, { retryable: true, scope: "transient" });
    expect(records.size).toBe(100_000);
    expect(records.has("chat:unit:100002")).toBe(true);
  });

  it("fails open and consumes rejected Promise results from an async store", async () => {
    const store = {
      compareAndSet: () => Promise.reject(new Error("async cas failed")),
      delete: () => Promise.reject(new Error("async delete failed")),
      entries: () => Promise.reject(new Error("async entries failed")),
      get: () => Promise.reject(new Error("async get failed")),
      set: () => Promise.reject(new Error("async set failed")),
    } as unknown as RouterHealthStore;
    const state = new CandidateHealthState("chat", store);

    expect(state.available(0)).toBe(true);
    expect(state.failure(0, { retryable: true, scope: "transient" })).toBe(
      "cas-exhausted"
    );
    expect(state.claimProbe(0)).toBe(false);
    expect(state.snapshot()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("fails open without reading custom health-store then getters", () => {
    let reads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        reads += 1;
        throw new Error("then getter must not run");
      },
    });
    const store = {
      delete: () => thenable,
      get: () => thenable,
      set: () => thenable,
    } as unknown as RouterHealthStore;
    const state = new CandidateHealthState("chat", store);

    expect(state.available(0)).toBe(true);
    expect(state.failure(0, { retryable: true, scope: "transient" })).toBe(
      "cas-exhausted"
    );
    expect(state.snapshot()).toHaveLength(1);
    expect(reads).toBe(0);
  });

  it("consumes Promise-valued health-record fields without probing thenables", async () => {
    let hasReads = 0;
    const thenable = new Proxy(
      { cooldownUntil: 0, failures: 0 },
      {
        has() {
          hasReads += 1;
          throw new Error("then membership must not be probed");
        },
      }
    );
    const records = [
      {
        cooldownUntil: Promise.reject(new Error("async cooldown field")),
        failures: Promise.reject(new Error("async failures field")),
        lastFailureAt: Promise.reject(new Error("async ordering field")),
      },
      thenable,
    ];
    const store = {
      delete: () => undefined,
      get: () => records.shift(),
      set: () => undefined,
    } as unknown as RouterHealthStore;
    const state = new CandidateHealthState("chat", store);

    expect(state.available(0)).toBe(true);
    expect(state.available(0)).toBe(true);
    expect(hasReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("normalizes custom store records without invoking accessors", () => {
    let reads = 0;
    let record: object = Object.defineProperty(
      { cooldownUntil: 10_000, failures: 1 },
      "lastStatus",
      {
        get() {
          reads += 1;
          return 429;
        },
      }
    );
    const store = {
      delete: () => undefined,
      get: () => record,
      set: () => undefined,
    } as RouterHealthStore;
    const state = new CandidateHealthState("chat", store, () => 1000);

    expect(state.available(0)).toBe(false);
    expect(reads).toBe(0);

    record = Object.create(
      Object.defineProperty({}, "cooldownUntil", {
        get() {
          reads += 1;
          return 10_000;
        },
      })
    );
    Object.defineProperty(record, "failures", { value: 1 });
    expect(state.available(0)).toBe(true);
    expect(reads).toBe(0);
  });

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

  it("fails open for throwing or malformed optional CAS methods", () => {
    const fallbackStore = new MemoryRouterHealthStore();
    Object.defineProperty(fallbackStore, "compareAndSet", {
      get() {
        throw new Error("CAS getter failed");
      },
    });
    const fallbackState = new CandidateHealthState(
      "chat",
      fallbackStore,
      () => 0
    );
    expect(
      fallbackState.failure(0, { retryable: true, scope: "transient" })
    ).toBe("cooling");

    class MalformedCasStore extends MemoryRouterHealthStore {
      override compareAndSet(): boolean {
        return "yes" as never;
      }
    }
    const malformedStore = new MalformedCasStore();
    malformedStore.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 1,
      lastFailureAt: 1,
    });
    const malformedState = new CandidateHealthState(
      "chat",
      malformedStore,
      () => 100
    );
    expect(malformedState.claimProbe(0)).toBe(true);
    expect(malformedStore.get("chat:unit:0")?.probingUntil).toBeUndefined();
  });

  it("prunes stale healthy tombstones", () => {
    let now = 0;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );
    state.success(0, undefined, undefined, 1);
    now = 86_400_001;

    expect(state.snapshot()).toEqual([]);
  });

  it("does not race-delete stale tombstones from a custom shared store", () => {
    const record = {
      cooldownUntil: 0,
      failures: 0,
      observedAtMs: 0,
      version: 1,
    };
    let deletes = 0;
    const store: RouterHealthStore = {
      delete: () => {
        deletes += 1;
      },
      get: () => record,
      set: () => undefined,
    };
    const state = new CandidateHealthState("chat", store, () => 86_400_001);
    state.register(0);

    expect(state.snapshot()).toEqual([]);
    expect(deletes).toBe(0);
  });

  it("snapshots configured keys without enumerating the whole store", () => {
    const records = new Map<string, Parameters<RouterHealthStore["set"]>[1]>();
    const store: RouterHealthStore = {
      delete: (key) => {
        records.delete(key);
      },
      get: (key) => records.get(key),
      set: (key, value) => {
        records.set(key, value);
      },
    };
    const state = new CandidateHealthState("chat", store, () => 0);
    state.register(0, "credential");
    state.failure(0, { retryable: true, scope: "credential" }, "credential");

    expect(state.snapshot()).toHaveLength(1);
  });

  it("claims only the newest expired health scope lease", () => {
    const store = new MemoryRouterHealthStore();
    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 1,
      lastFailureAt: 10,
    });
    store.set("chat:credential:key", {
      cooldownUntil: 0,
      failures: 1,
      lastFailureAt: 20,
    });
    const state = new CandidateHealthState("chat", store, () => 100);

    expect(state.available(0, "key")).toBe(true);
    expect(state.claimProbe(0, "key")).toBe(true);
    expect(store.get("chat:unit:0")?.probingUntil).toBeUndefined();
    expect(store.get("chat:credential:key")?.probingUntil).toBe(30_100);
  });

  it("uses Retry-After when it exceeds the default cooldown", () => {
    let now = 0;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );
    state.failure(0, {
      retryable: true,
      retryAfterMs: 120_000,
      scope: "credential",
    });
    now = 119_999;
    expect(state.available(0)).toBe(false);
    now = 120_001;
    expect(state.available(0)).toBe(true);
    expect(state.claimProbe(0)).toBe(true);
    expect(state.available(0)).toBe(false);
  });

  it("uses one clock snapshot for each availability decision", () => {
    let now = 1000;
    let advancing = false;
    let reads = 0;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => (advancing ? now + reads++ : now)
    );
    state.failure(0, { retryable: true, scope: "transient" });
    const cooldownUntil = state.snapshot()[0].record.cooldownUntil;

    now = cooldownUntil - 1;
    reads = 0;
    advancing = true;
    expect(state.available(0)).toBe(false);
    expect(reads).toBe(1);

    reads = 0;
    expect(state.claimProbe(0)).toBe(false);
    expect(reads).toBe(1);
  });

  it("uses one observed time across all records cleared by a success", () => {
    let reads = 0;
    const store = new MemoryRouterHealthStore();
    const state = new CandidateHealthState(
      "chat",
      store,
      () => 1000 + reads++,
      "shared"
    );

    state.success(0, "key", "family", 200);

    expect(reads).toBe(1);
    const observed = [...store.entries()].map(
      ([, record]) => record.observedAtMs
    );
    expect(observed).toEqual([1000, 1000, 1000]);
  });

  it("reconciles a recovery across partially committed health scopes", () => {
    class PartiallyContendedStore extends MemoryRouterHealthStore {
      override compareAndSet(
        key: string,
        expectedVersion: number | undefined,
        value: RouterHealthRecord
      ): boolean {
        if (key === "shared:credential:key") {
          return false;
        }
        return super.compareAndSet(key, expectedVersion, value);
      }
    }
    const store = new PartiallyContendedStore();
    for (const key of [
      "chat:unit:0",
      "shared:credential:key",
      "shared:family:family",
    ]) {
      store.set(key, {
        cooldownUntil: 20_000,
        failures: 1,
        lastFailureAt: 10,
        observedAtMs: 1000,
        version: 1,
      });
    }
    const state = new CandidateHealthState("chat", store, () => 1000, "shared");
    const observer = new CandidateHealthState(
      "chat",
      store,
      () => 1000,
      "shared"
    );

    expect(state.success(0, "key", "family", 20)).toBe("cas-exhausted");
    expect(state.available(0, "key", "family")).toBe(true);
    expect(observer.available(0, "key", "family")).toBe(true);
    expect(state.snapshot()).toEqual([]);
    expect(store.get("chat:unit:0")).toMatchObject({ failures: 0 });
    expect(store.get("shared:family:family")).toMatchObject({ failures: 0 });
    expect(store.get("shared:credential:key")).toMatchObject({ failures: 1 });

    store.set("shared:credential:key", {
      cooldownUntil: 30_000,
      failures: 2,
      lastFailureAt: 30,
      observedAtMs: 1001,
      version: 2,
    });
    expect(observer.available(0, "key", "family")).toBe(false);
  });

  it("keeps a newer failed scope when other recovery scopes commit", () => {
    const store = new MemoryRouterHealthStore();
    store.set("chat:unit:0", {
      cooldownUntil: 20_000,
      failures: 1,
      lastFailureAt: 10,
      observedAtMs: 1000,
      version: 1,
    });
    store.set("shared:credential:key", {
      cooldownUntil: 30_000,
      failures: 1,
      lastFailureAt: 30,
      observedAtMs: 1001,
      version: 1,
    });
    const state = new CandidateHealthState("chat", store, () => 1000, "shared");

    expect(state.success(0, "key", undefined, 20)).toBe("ignored-stale");
    expect(store.get("chat:unit:0")).toMatchObject({ failures: 0 });
    expect(store.get("shared:credential:key")).toMatchObject({
      failures: 1,
      lastFailureAt: 30,
    });
    expect(state.available(0, "key")).toBe(false);
  });

  it("shares one clock read for an implicit success ordering token", () => {
    let reads = 0;
    const store = new MemoryRouterHealthStore();
    const state = new CandidateHealthState("chat", store, () => 1000 + reads++);

    state.success(0);

    expect(reads).toBe(1);
    expect(store.get("chat:unit:0")).toMatchObject({
      lastSuccessAt: 1000,
      observedAtMs: 1000,
    });
  });

  it("shares one clock read across an implicit failure transition", () => {
    let reads = 0;
    const store = new MemoryRouterHealthStore();
    const state = new CandidateHealthState("chat", store, () => 1000 + reads++);

    state.failure(0, { retryable: true, scope: "transient" });

    expect(reads).toBe(1);
    expect(store.get("chat:unit:0")).toMatchObject({
      cooldownUntil: 16_000,
      lastFailureAt: 1000,
      observedAtMs: 1000,
    });
  });

  it("freezes health time across invalid clock samples and resumes on recovery", () => {
    let now: number | "throw" = 1000;
    const store = new MemoryRouterHealthStore();
    const state = new CandidateHealthState("chat", store, () => {
      if (now === "throw") {
        throw new Error("health clock unavailable");
      }
      return now;
    });

    state.failure(0, { retryable: true, scope: "transient" });
    now = "throw";
    expect(() => state.snapshot()).not.toThrow();
    expect(state.available(0)).toBe(false);

    now = Number.NaN;
    expect(state.available(0)).toBe(false);
    now = -1;
    expect(state.claimProbe(0)).toBe(false);

    now = Number.MAX_VALUE;
    expect(state.available(0)).toBe(false);

    now = 16_001.5;
    expect(state.available(0)).toBe(true);
    expect(state.claimProbe(0)).toBe(true);
  });

  it("consumes Promise-valued health clock samples", async () => {
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      (() => Promise.reject(new Error("async health clock"))) as never
    );

    expect(state.available(0)).toBe(true);
    state.failure(0, { retryable: true, scope: "transient" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("honors an explicit hard-auth cooldown floor", () => {
    let now = 0;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );
    state.failure(0, {
      cooldownMs: 3_600_000,
      retryable: true,
      scope: "credential",
      statusCode: 401,
    });
    now = 3_599_999;
    expect(state.available(0)).toBe(false);
    now = 3_600_001;
    expect(state.available(0)).toBe(true);
  });

  it("exponentially increases repeated cooldowns up to the one-hour cap", () => {
    let now = 0;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );
    const expectedDurations = [
      15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000,
      3_600_000, 3_600_000,
    ];

    for (const [index, duration] of expectedDurations.entries()) {
      expect(
        state.failure(
          0,
          { retryable: true, scope: "transient" },
          undefined,
          undefined,
          index
        )
      ).toBe("cooling");
      expect(state.snapshot()[0].record).toMatchObject({
        cooldownUntil: now + duration,
        failures: index + 1,
      });
      now += duration + 1;
    }
  });

  it("deduplicates concurrent failures in one cooldown window", () => {
    let now = 1000;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );
    expect(
      state.failure(
        0,
        { retryable: true, scope: "credential", statusCode: 429 },
        undefined,
        undefined,
        900
      )
    ).toBe("cooling");
    now += 1;
    expect(
      state.failure(
        0,
        { retryable: true, scope: "credential", statusCode: 429 },
        undefined,
        undefined,
        901
      )
    ).toBe("deduplicated");
    expect(state.snapshot()[0].record.failures).toBe(1);
  });

  it("does not let an older deduplicated failure overwrite latest status", () => {
    let now = 1000;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );
    state.failure(
      0,
      { retryable: true, scope: "credential", statusCode: 429 },
      undefined,
      undefined,
      200
    );
    now += 1;

    expect(
      state.failure(
        0,
        {
          retryable: true,
          retryAfterMs: 120_000,
          scope: "credential",
          statusCode: 401,
        },
        undefined,
        undefined,
        100
      )
    ).toBe("deduplicated");
    expect(state.snapshot()[0].record).toMatchObject({
      cooldownUntil: now + 120_000,
      failures: 1,
      lastFailureAt: 200,
      lastStatus: 429,
    });
  });

  it("caps oversized cooldown hints on deduplicated failures", () => {
    let now = 1000;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );
    state.failure(0, { retryable: true, scope: "credential" });
    now += 1;

    expect(
      state.failure(0, {
        retryable: true,
        retryAfterMs: Number.MAX_SAFE_INTEGER,
        scope: "credential",
      })
    ).toBe("deduplicated");
    expect(state.snapshot()[0].record).toMatchObject({
      cooldownUntil: now + 3_600_000,
      failures: 1,
    });
  });

  it("lets a newer deduplicated failure update latest status", () => {
    let now = 1000;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );
    state.failure(
      0,
      { retryable: true, scope: "credential", statusCode: 429 },
      undefined,
      undefined,
      100
    );
    now += 1;

    expect(
      state.failure(
        0,
        { retryable: true, scope: "credential", statusCode: 503 },
        undefined,
        undefined,
        200
      )
    ).toBe("deduplicated");
    expect(state.snapshot()[0].record).toMatchObject({
      failures: 1,
      lastFailureAt: 200,
      lastStatus: 503,
    });
  });

  it("ignores a delayed failure from an attempt older than a success", () => {
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => 1000
    );
    state.success(0, undefined, undefined, 200);
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

  it("ignores a delayed older failure after the newer cooldown expires", () => {
    let now = 1000;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );
    state.failure(
      0,
      { retryable: true, scope: "transient", statusCode: 503 },
      undefined,
      undefined,
      200
    );
    now = 20_000;

    expect(
      state.failure(
        0,
        { retryable: true, scope: "transient", statusCode: 429 },
        undefined,
        undefined,
        100
      )
    ).toBe("ignored-stale");
    expect(state.snapshot()[0].record).toMatchObject({
      cooldownUntil: 16_000,
      failures: 1,
      lastFailureAt: 200,
      lastStatus: 503,
    });
    expect(state.success(0, undefined, undefined, 150)).toBe("ignored-stale");
  });

  it("does not count the same failure token again after cooldown expiry", () => {
    let now = 1000;
    const state = new CandidateHealthState(
      "chat",
      new MemoryRouterHealthStore(),
      () => now
    );
    state.failure(
      0,
      { retryable: true, scope: "transient" },
      undefined,
      undefined,
      100
    );
    now = 20_000;

    expect(
      state.failure(
        0,
        { retryable: true, scope: "transient" },
        undefined,
        undefined,
        100
      )
    ).toBe("ignored-stale");
    expect(state.snapshot()[0].record.failures).toBe(1);
  });

  it("orders new string tokens against legacy numeric store records", () => {
    const store = new MemoryRouterHealthStore();
    const state = new CandidateHealthState("chat", store, () => 0);
    const legacy = 2_000_000_000_000 * 4096;
    store.set("chat:unit:0", {
      cooldownUntil: 0,
      failures: 0,
      lastSuccessAt: legacy,
    });

    expect(
      state.failure(
        0,
        { retryable: true, scope: "transient" },
        undefined,
        undefined,
        "v1:1999999999999:router00:000001"
      )
    ).toBe("ignored-stale");
  });
});
