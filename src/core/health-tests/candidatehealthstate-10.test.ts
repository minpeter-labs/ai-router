import { describe, expect, it } from "vitest";
import { CandidateHealthState } from "../candidate-health";
import { MemoryRouterHealthStore } from "../health-store";

describe("CandidateHealthState", () => {
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
