import { describe, expect, it } from "vitest";
import { CandidateHealthState } from "../candidate-health";
import { MemoryRouterHealthStore } from "../health-store";
import type { RouterHealthStore } from "../types";

describe("CandidateHealthState", () => {
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
});
