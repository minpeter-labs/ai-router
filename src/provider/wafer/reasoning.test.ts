import { describe, expect, it } from "vitest";

import { waferReasoningTransform } from "./reasoning";

// Wafer reasoning dialect: thinking.type ('enabled' | 'disabled').
// (The generic strip/classify/immutability scaffolding is tested in core.)

describe("waferReasoningTransform", () => {
  for (const effort of ["low", "medium", "high", "minimal", "xhigh"] as const) {
    it(`maps reasoning_effort '${effort}' -> thinking.type='enabled'`, () => {
      const out = waferReasoningTransform({
        model: "m",
        reasoning_effort: effort,
      });
      expect(out.thinking).toEqual({ type: "enabled" });
      expect("reasoning_effort" in out).toBe(false);
    });
  }

  it("maps reasoning_effort true -> thinking.type='enabled'", () => {
    const out = waferReasoningTransform({ reasoning_effort: true });
    expect(out.thinking).toEqual({ type: "enabled" });
  });

  it("maps reasoning_effort 'none' -> thinking.type='disabled'", () => {
    const out = waferReasoningTransform({ reasoning_effort: "none" });
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  it("maps reasoning_effort false -> thinking.type='disabled'", () => {
    const out = waferReasoningTransform({ reasoning_effort: false });
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  it("merges into an existing thinking object, preserving other keys", () => {
    const out = waferReasoningTransform({
      reasoning_effort: "medium",
      thinking: { budget_tokens: 2048 },
    });
    expect(out.thinking).toEqual({ budget_tokens: 2048, type: "enabled" });
  });

  it("overrides an existing type key", () => {
    const out = waferReasoningTransform({
      reasoning_effort: "none",
      thinking: { type: "enabled", keep: "me" },
    });
    expect(out.thinking).toEqual({ type: "disabled", keep: "me" });
  });

  it("does not write a reasoning (openrouter) key", () => {
    const out = waferReasoningTransform({ reasoning_effort: "high" });
    expect("reasoning" in out).toBe(false);
  });

  it("does not write a chat_template_kwargs (friendli) key", () => {
    const out = waferReasoningTransform({ reasoning_effort: "high" });
    expect("chat_template_kwargs" in out).toBe(false);
  });

  it("leaves the body unchanged when no reasoning_effort is set", () => {
    const input = { model: "m", thinking: { type: "enabled" } };
    const out = waferReasoningTransform(input);
    expect(out).toEqual(input);
  });

  it("does not mutate a nested existing thinking object", () => {
    const nested = { budget_tokens: 100 };
    const input: Record<string, unknown> = {
      reasoning_effort: "low",
      thinking: nested,
    };
    const out = waferReasoningTransform(input);
    expect(nested).toEqual({ budget_tokens: 100 });
    expect(out.thinking).not.toBe(nested);
  });
});
