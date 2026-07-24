import { describe, expect, it } from "vitest";

import { friendliReasoningTransform } from "./reasoning";

// Friendli reasoning dialect: chat_template_kwargs.{thinking, enable_thinking}.
// (The generic strip/classify/immutability scaffolding is tested in core.)

describe("friendliReasoningTransform", () => {
  for (const effort of ["low", "medium", "high", "minimal", "xhigh"] as const) {
    it(`maps reasoning_effort '${effort}' -> thinking/enable_thinking=true`, () => {
      const out = friendliReasoningTransform({
        model: "m",
        reasoning_effort: effort,
      });
      expect(out.chat_template_kwargs).toEqual({
        thinking: true,
        enable_thinking: true,
      });
      expect("reasoning_effort" in out).toBe(false);
    });
  }

  it("maps reasoning_effort true -> thinking/enable_thinking=true", () => {
    const out = friendliReasoningTransform({ reasoning_effort: true });
    expect(out.chat_template_kwargs).toEqual({
      thinking: true,
      enable_thinking: true,
    });
  });

  it("maps reasoning_effort 'none' -> thinking/enable_thinking=false", () => {
    const out = friendliReasoningTransform({ reasoning_effort: "none" });
    expect(out.chat_template_kwargs).toEqual({
      thinking: false,
      enable_thinking: false,
    });
  });

  it("maps reasoning_effort false -> thinking/enable_thinking=false", () => {
    const out = friendliReasoningTransform({ reasoning_effort: false });
    expect(out.chat_template_kwargs).toEqual({
      thinking: false,
      enable_thinking: false,
    });
  });

  it("merges into an existing chat_template_kwargs, preserving other keys", () => {
    const out = friendliReasoningTransform({
      reasoning_effort: "high",
      chat_template_kwargs: { foo: "bar" },
    });
    expect(out.chat_template_kwargs).toEqual({
      foo: "bar",
      thinking: true,
      enable_thinking: true,
    });
  });

  it("overrides existing thinking / enable_thinking keys", () => {
    const out = friendliReasoningTransform({
      reasoning_effort: "none",
      chat_template_kwargs: {
        thinking: true,
        enable_thinking: true,
        keep: "me",
      },
    });
    expect(out.chat_template_kwargs).toEqual({
      thinking: false,
      enable_thinking: false,
      keep: "me",
    });
  });

  it("does not write a reasoning (openrouter) key", () => {
    const out = friendliReasoningTransform({ reasoning_effort: "high" });
    expect("reasoning" in out).toBe(false);
  });

  it("leaves the body unchanged when no reasoning_effort is set", () => {
    const input = { model: "m", chat_template_kwargs: { thinking: true } };
    const out = friendliReasoningTransform(input);
    expect(out).toEqual(input);
  });

  it("does not mutate a nested existing chat_template_kwargs", () => {
    const nested = { foo: "bar" };
    const input: Record<string, unknown> = {
      reasoning_effort: "low",
      chat_template_kwargs: nested,
    };
    const out = friendliReasoningTransform(input);
    expect(nested).toEqual({ foo: "bar" });
    expect(out.chat_template_kwargs).not.toBe(nested);
  });
});
