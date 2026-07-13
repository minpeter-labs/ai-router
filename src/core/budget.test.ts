import { describe, expect, it } from "vitest";
import { RetryBudget } from "./budget";

describe("RetryBudget", () => {
  it("consumes Promise-valued injected clock samples", async () => {
    const budget = new RetryBudget((() =>
      Promise.reject(new Error("async budget clock"))) as never);

    expect(budget.available()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("maintains exact failure counts across bounded overflow and pruning", () => {
    let now = 0;
    const budget = new RetryBudget(() => now, 10, {
      maxSamples: 3,
      minSamples: 1,
      recoveryFailureRate: 0.25,
      tripFailureRate: 0.75,
    });
    budget.observe(false);
    budget.observe(true);
    budget.observe(false);
    budget.observe(true);

    expect(budget.snapshot()).toMatchObject({ failures: 1, samples: 3 });
    now = 11;
    expect(budget.snapshot()).toMatchObject({
      failureRate: 0,
      failures: 0,
      samples: 0,
    });
  });

  it("preserves counts through repeated compaction, clock rollback, and expiry", () => {
    let now = 100_000;
    const budget = new RetryBudget(() => now, 10_000, {
      maxSamples: 1000,
      minSamples: 1,
      recoveryFailureRate: 0.2,
      tripFailureRate: 0.8,
    });
    for (let index = 0; index < 5000; index += 1) {
      budget.observe(index % 4 !== 0);
    }

    expect(budget.snapshot()).toMatchObject({
      failureRate: 0.25,
      failures: 250,
      samples: 1000,
    });
    now = 99_000;
    expect(budget.snapshot()).toMatchObject({
      failureRate: 0.25,
      failures: 250,
      samples: 1000,
    });
    now = 109_001;
    expect(budget.snapshot()).toMatchObject({
      failureRate: 0,
      failures: 0,
      samples: 0,
    });
  });
  it("trips on an outage and recovers with hysteresis", () => {
    const budget = new RetryBudget();
    for (let index = 0; index < 5; index++) {
      budget.observe(false);
    }
    expect(budget.available()).toBe(false);
    for (let index = 0; index < 20; index++) {
      budget.observe(true);
    }
    expect(budget.available()).toBe(true);
  });

  it("forgets stale failures after the time window", () => {
    let now = 0;
    const budget = new RetryBudget(() => now, 1000);
    for (let index = 0; index < 5; index++) {
      budget.observe(false);
    }
    expect(budget.available()).toBe(false);
    now = 1001;
    expect(budget.available()).toBe(true);
  });

  it("retains samples at the inclusive window boundary and expires them after", () => {
    let now = 0;
    const budget = new RetryBudget(() => now, 1000, {
      minSamples: 1,
      recoveryFailureRate: 0,
      tripFailureRate: 1,
    });
    budget.observe(false);

    now = 1000;
    expect(budget.snapshot()).toMatchObject({
      available: false,
      failures: 1,
      samples: 1,
    });

    now = 1001;
    expect(budget.snapshot()).toMatchObject({
      available: true,
      failures: 0,
      samples: 0,
    });
  });

  it("recomputes hysteresis when stale failures expire but enough samples remain", () => {
    let now = 0;
    const budget = new RetryBudget(() => now, 1000, {
      minSamples: 2,
      recoveryFailureRate: 0.4,
      tripFailureRate: 0.8,
    });
    for (let index = 0; index < 5; index++) {
      budget.observe(false);
    }
    now = 500;
    for (let index = 0; index < 3; index++) {
      budget.observe(true);
    }
    expect(budget.available()).toBe(false);

    now = 1001;

    expect(budget.snapshot()).toMatchObject({
      available: true,
      failureRate: 0,
      failures: 0,
      samples: 3,
      tripped: false,
    });
  });

  it("preserves the window length across wall-clock rollback", () => {
    let now = 10_000;
    const budget = new RetryBudget(() => now, 1000);
    for (let index = 0; index < 5; index++) {
      budget.observe(false);
    }
    expect(budget.available()).toBe(false);

    now = 0;
    expect(budget.available()).toBe(false);
    now = 1001;

    expect(budget.snapshot()).toMatchObject({
      available: true,
      failures: 0,
      samples: 0,
      tripped: false,
    });
  });

  it("freezes on invalid clocks without poisoning sample timestamps", () => {
    let now = 0;
    const budget = new RetryBudget(() => now, 1000);
    for (let index = 0; index < 5; index++) {
      budget.observe(false);
    }
    expect(budget.available()).toBe(false);

    now = Number.NaN;
    budget.observe(true);
    now = Number.POSITIVE_INFINITY;
    expect(budget.snapshot().samples).toBe(6);
    now = -1;
    expect(budget.snapshot().samples).toBe(6);

    now = 1001;
    expect(budget.snapshot()).toMatchObject({
      available: true,
      failures: 0,
      samples: 0,
    });
  });

  it("freezes when the retry-budget clock throws", () => {
    let throwing = false;
    let now = 0;
    const budget = new RetryBudget(() => {
      if (throwing) {
        throw new Error("clock unavailable");
      }
      return now;
    }, 1000);
    for (let index = 0; index < 5; index += 1) {
      budget.observe(false);
    }

    throwing = true;
    expect(() => budget.available()).not.toThrow();
    expect(budget.available()).toBe(false);

    throwing = false;
    now = 1001;
    expect(budget.available()).toBe(true);
  });

  it("supports custom samples and hysteresis thresholds", () => {
    const budget = new RetryBudget(Date.now, 60_000, {
      maxSamples: 4,
      minSamples: 2,
      recoveryFailureRate: 0.25,
      tripFailureRate: 0.5,
    });
    budget.observe(false);
    budget.observe(true);
    expect(budget.snapshot()).toMatchObject({
      failureRate: 0.5,
      failures: 1,
      samples: 2,
      tripped: true,
    });
    for (let index = 0; index < 3; index++) {
      budget.observe(true);
    }
    expect(budget.snapshot()).toMatchObject({
      failureRate: 0,
      samples: 4,
      tripped: false,
    });
  });

  it("recovers at zero failures when the recovery threshold is zero", () => {
    const budget = new RetryBudget(Date.now, 60_000, {
      maxSamples: 4,
      minSamples: 2,
      recoveryFailureRate: 0,
      tripFailureRate: 0.5,
    });
    budget.observe(false);
    budget.observe(false);
    expect(budget.available()).toBe(false);

    for (let index = 0; index < 4; index++) {
      budget.observe(true);
    }

    expect(budget.snapshot()).toMatchObject({
      available: true,
      failureRate: 0,
      failures: 0,
      samples: 4,
      tripped: false,
    });
  });

  it("rejects invalid retry budget policies", () => {
    expect(
      () => new RetryBudget(Date.now, 1000, { minSamples: 3, maxSamples: 2 })
    ).toThrow("minSamples");
    expect(
      () =>
        new RetryBudget(Date.now, 1000, {
          recoveryFailureRate: 0.9,
          tripFailureRate: 0.8,
        })
    ).toThrow("recoveryFailureRate");
    expect(
      () => new RetryBudget(Date.now, 1000, { tripFailureRate: 0 })
    ).toThrow("tripFailureRate");
    expect(
      () => new RetryBudget(Date.now, 1000, { maxSamples: 10_001 })
    ).toThrow("maxSamples");
    expect(() => new RetryBudget(Date.now, 0)).toThrow("safe integer");
    expect(
      () => new RetryBudget(Date.now, Number.MAX_SAFE_INTEGER + 1)
    ).toThrow("safe integer");
  });
});
