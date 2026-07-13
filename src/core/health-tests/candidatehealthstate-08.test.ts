import { describe, expect, it } from "vitest";
import { CandidateHealthState } from "../candidate-health";
import { MemoryRouterHealthStore } from "../health-store";
import type { RouterHealthRecord } from "../types";

describe("CandidateHealthState", () => {
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
});
