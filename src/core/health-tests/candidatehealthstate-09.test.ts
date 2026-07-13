import { describe, expect, it } from "vitest";
import { CandidateHealthState } from "../candidate-health";
import { MemoryRouterHealthStore } from "../health-store";

describe("CandidateHealthState", () => {
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
});
