import { describe, expect, it } from "vitest";
import { RetryBudget } from "../budget";

describe("RetryBudget", () => {
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
