import { describe, expect, it } from "vitest";

import { waferReasoningTransform } from "./reasoning";

// Wafer reasoning dialect: an explicit level is forwarded verbatim as
// reasoning_effort (granular); on-without-level / off fall back to thinking.type.
// (The generic strip/classify/immutability scaffolding is tested in core.)

describe("waferReasoningTransform", () => {
  for (const effort of ["low", "medium", "high", "max"] as const) {
    it(`forwards reasoning_effort '${effort}' verbatim`, () => {
      const out = waferReasoningTransform({
        model: "m",
        reasoning_effort: effort,
      });
      expect(out.reasoning_effort).toBe(effort);
      expect("thinking" in out).toBe(false);
    });
  }

  it("maps reasoning_effort true (no level) -> thinking.type='enabled'", () => {
    const out = waferReasoningTransform({ reasoning_effort: true });
    expect(out.thinking).toEqual({ type: "enabled" });
    expect("reasoning_effort" in out).toBe(false);
  });

  it("maps reasoning_effort 'none' -> thinking.type='disabled'", () => {
    const out = waferReasoningTransform({ reasoning_effort: "none" });
    expect(out.thinking).toEqual({ type: "disabled" });
    expect("reasoning_effort" in out).toBe(false);
  });

  it("maps reasoning_effort false -> thinking.type='disabled'", () => {
    const out = waferReasoningTransform({ reasoning_effort: false });
    expect(out.thinking).toEqual({ type: "disabled" });
    expect("reasoning_effort" in out).toBe(false);
  });

  it("does not write a reasoning (openrouter) key", () => {
    const out = waferReasoningTransform({ reasoning_effort: "high" });
    expect("reasoning" in out).toBe(false);
  });

  it("does not write a chat_template_kwargs (friendli) key", () => {
    const out = waferReasoningTransform({ reasoning_effort: "high" });
    expect("chat_template_kwargs" in out).toBe(false);
  });

  it("preserves an existing thinking object when disabling", () => {
    const out = waferReasoningTransform({
      reasoning_effort: "none",
      thinking: { keep: "all" },
    });
    expect(out.thinking).toEqual({ keep: "all", type: "disabled" });
  });

  it("leaves the body unchanged when no reasoning_effort is set", () => {
    const input = { model: "m", thinking: { type: "enabled" } };
    const out = waferReasoningTransform(input);
    expect(out).toEqual(input);
  });

  it("does not mutate a nested existing thinking object when disabling", () => {
    const nested = { keep: "all" };
    const input: Record<string, unknown> = {
      reasoning_effort: "none",
      thinking: nested,
    };
    const out = waferReasoningTransform(input);
    expect(nested).toEqual({ keep: "all" });
    expect(out.thinking).not.toBe(nested);
  });
});
