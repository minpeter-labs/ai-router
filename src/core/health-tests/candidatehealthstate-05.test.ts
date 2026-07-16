import { describe, expect, it } from "vitest";
import { CandidateHealthState } from "../candidate-health";
import { MemoryRouterHealthStore } from "../health-store";
import type { RouterHealthRecord, RouterHealthStore } from "../types";

describe("CandidateHealthState", () => {
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
});
