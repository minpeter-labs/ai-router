import { describe, expect, it } from "vitest";
import { CandidateHealthState } from "../candidate-health";
import { MemoryRouterHealthStore } from "../health-store";

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
});
