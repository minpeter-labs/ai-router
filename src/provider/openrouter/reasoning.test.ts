import { describe, expect, it } from "vitest";

import { openrouterReasoningTransform } from "./reasoning";

// OpenRouter reasoning dialect: reasoning.enabled.
// (The generic strip/classify/immutability scaffolding is tested in core.)

describe("openrouterReasoningTransform", () => {
  for (const effort of ["low", "medium", "high", "minimal", "xhigh"] as const) {
    it(`maps reasoning_effort '${effort}' -> reasoning.enabled=true`, () => {
      const out = openrouterReasoningTransform({
        model: "m",
        reasoning_effort: effort,
      });
      expect(out.reasoning).toEqual({ enabled: true });
      expect("reasoning_effort" in out).toBe(false);
    });
  }

  it("maps reasoning_effort true -> reasoning.enabled=true", () => {
    const out = openrouterReasoningTransform({ reasoning_effort: true });
    expect(out.reasoning).toEqual({ enabled: true });
  });

  it("maps reasoning_effort 'none' -> reasoning.enabled=false", () => {
    const out = openrouterReasoningTransform({ reasoning_effort: "none" });
    expect(out.reasoning).toEqual({ enabled: false });
  });

  it("maps reasoning_effort false -> reasoning.enabled=false", () => {
    const out = openrouterReasoningTransform({ reasoning_effort: false });
    expect(out.reasoning).toEqual({ enabled: false });
  });

  it("merges into an existing reasoning object, preserving other keys", () => {
    const out = openrouterReasoningTransform({
      reasoning_effort: "medium",
      reasoning: { max_tokens: 2048, exclude: false },
    });
    expect(out.reasoning).toEqual({
      max_tokens: 2048,
      exclude: false,
      enabled: true,
    });
  });

  it("overrides an existing enabled key", () => {
    const out = openrouterReasoningTransform({
      reasoning_effort: "none",
      reasoning: { enabled: true, keep: "me" },
    });
    expect(out.reasoning).toEqual({ enabled: false, keep: "me" });
  });

  it("does not write a chat_template_kwargs (friendli) key", () => {
    const out = openrouterReasoningTransform({ reasoning_effort: "high" });
    expect("chat_template_kwargs" in out).toBe(false);
  });

  it("leaves the body unchanged when no reasoning_effort is set", () => {
    const input = { model: "m", reasoning: { enabled: true } };
    const out = openrouterReasoningTransform(input);
    expect(out).toEqual(input);
  });

  it("does not mutate a nested existing reasoning object", () => {
    const nested = { max_tokens: 100 };
    const input: Record<string, unknown> = {
      reasoning_effort: "low",
      reasoning: nested,
    };
    const out = openrouterReasoningTransform(input);
    expect(nested).toEqual({ max_tokens: 100 });
    expect(out.reasoning).not.toBe(nested);
  });
});
