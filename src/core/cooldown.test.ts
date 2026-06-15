import { describe, expect, it } from "vitest";

import { resolveCooldown } from "./cooldown";

const INVALID_COOLDOWN_RE = /invalid cooldown/;

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
});
