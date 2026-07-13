import { describe, expect, it } from "vitest";

import { CooldownState, resolveCooldown } from "./cooldown";

const INVALID_COOLDOWN_RE = /invalid (?:cooldown|duration)/;

describe("resolveCooldown", () => {
  it("treats omitted / false / 0 as OFF", () => {
    expect(resolveCooldown(undefined)).toBeUndefined();
    expect(resolveCooldown(false)).toBeUndefined();
    expect(resolveCooldown(0)).toBeUndefined();
  });

  it("uses the 3-minute default for `true`", () => {
    expect(resolveCooldown(true)).toEqual({ modelResetInterval: 180_000 });
  });

  it("accepts a millisecond number", () => {
    expect(resolveCooldown(60_000)).toEqual({ modelResetInterval: 60_000 });
  });

  it("parses duration strings", () => {
    expect(resolveCooldown("500ms")).toEqual({ modelResetInterval: 500 });
    expect(resolveCooldown("30s")).toEqual({ modelResetInterval: 30_000 });
    expect(resolveCooldown("1m")).toEqual({ modelResetInterval: 60_000 });
    expect(resolveCooldown("2h")).toEqual({ modelResetInterval: 7_200_000 });
    expect(resolveCooldown("0.1ms")).toEqual({ modelResetInterval: 1 });
    expect(resolveCooldown(0.1)).toEqual({ modelResetInterval: 1 });
  });

  it("accepts the explicit config object", () => {
    expect(resolveCooldown({ modelResetInterval: 90_000 })).toEqual({
      modelResetInterval: 90_000,
    });
    expect(resolveCooldown({})).toEqual({ modelResetInterval: 180_000 });
  });

  it("throws on a malformed duration string", () => {
    expect(() => resolveCooldown("soon" as never)).toThrow(INVALID_COOLDOWN_RE);
  });

  it("rejects non-positive and non-finite enabled intervals", () => {
    for (const value of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => resolveCooldown(value)).toThrow(INVALID_COOLDOWN_RE);
    }
    expect(() => resolveCooldown("0s")).toThrow(INVALID_COOLDOWN_RE);
    expect(() => resolveCooldown({ modelResetInterval: -1 })).toThrow(
      INVALID_COOLDOWN_RE
    );
  });

  it("rejects malformed cooldown containers", () => {
    for (const value of [null, [], () => undefined]) {
      expect(() => resolveCooldown(value as never)).toThrow(
        "cooldown must be a boolean, duration, or config object"
      );
    }
  });

  it("consumes Promise-valued cooldown configuration", async () => {
    expect(() =>
      resolveCooldown(
        Promise.reject(new Error("async cooldown container")) as never
      )
    ).toThrow("synchronous");
    expect(() =>
      resolveCooldown({
        modelResetInterval: Promise.reject(
          new Error("async cooldown interval")
        ),
      } as never)
    ).toThrow("synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("CooldownState", () => {
  it("consumes Promise-valued injected clock samples", async () => {
    const state = new CooldownState({ modelResetInterval: 1000 }, (() =>
      Promise.reject(new Error("async cooldown clock"))) as never);

    state.advanceTo(1);
    state.checkAndReset();
    expect(state.current()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not extend a sticky interval after wall-clock rollback", () => {
    let now = 10_000;
    const state = new CooldownState({ modelResetInterval: 1000 }, () => now);
    state.advanceTo(1);

    now = 0;
    state.checkAndReset();
    expect(state.current()).toBe(1);
    now = 999;
    state.checkAndReset();
    expect(state.current()).toBe(1);
    now = 1000;
    state.checkAndReset();
    expect(state.current()).toBe(0);
  });

  it("freezes sticky time across invalid clock samples and resumes on recovery", () => {
    let now: number | "throw" = 1000;
    const state = new CooldownState({ modelResetInterval: 1000 }, () => {
      if (now === "throw") {
        throw new Error("cooldown clock unavailable");
      }
      return now;
    });
    state.advanceTo(1);

    now = "throw";
    expect(() => state.checkAndReset()).not.toThrow();
    expect(state.current()).toBe(1);
    now = Number.NaN;
    state.checkAndReset();
    expect(state.current()).toBe(1);
    now = -1;
    state.checkAndReset();
    expect(state.current()).toBe(1);
    now = Number.MAX_VALUE;
    state.checkAndReset();
    expect(state.current()).toBe(1);

    now = 2000;
    state.checkAndReset();
    expect(state.current()).toBe(0);
  });

  it("preserves fractional millisecond clock precision", () => {
    let now = 0.25;
    const state = new CooldownState({ modelResetInterval: 0.5 }, () => now);
    state.advanceTo(1);

    now = 0.74;
    state.checkAndReset();
    expect(state.current()).toBe(1);
    now = 0.75;
    state.checkAndReset();
    expect(state.current()).toBe(0);
  });

  it("constructs safely when the first clock sample throws", () => {
    const state = new CooldownState({ modelResetInterval: 1000 }, () => {
      throw new Error("cooldown clock unavailable");
    });

    expect(() => state.advanceTo(1)).not.toThrow();
    expect(() => state.checkAndReset()).not.toThrow();
    expect(state.current()).toBe(1);
  });
});
