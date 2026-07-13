import { describe, expect, it } from "vitest";
import { durationMs } from "../timeout";
import { COOLDOWN_RE, INVALID_DURATION_RE, MAX_DURATION_RE } from "./test-kit";

describe("durationMs", () => {
  it("rounds positive sub-millisecond durations up to one millisecond", () => {
    expect(durationMs("0.1ms")).toBe(1);
    expect(durationMs(0.1)).toBe(1);
  });

  it("uses generic duration diagnostics for malformed timeout strings", () => {
    expect(() => durationMs("soon" as never)).toThrow(INVALID_DURATION_RE);
    expect(() => durationMs("soon" as never)).not.toThrow(COOLDOWN_RE);
  });

  it("accepts at most 24 hours", () => {
    expect(durationMs("24h")).toBe(86_400_000);
    expect(() => durationMs("24.0001h")).toThrow(MAX_DURATION_RE);
  });
});
