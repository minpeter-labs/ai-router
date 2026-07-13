import { describe, expect, it } from "vitest";

import {
  createWaferRequestTransform,
  waferReasoningTransform,
} from "./reasoning";

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

  it("maps AI SDK minimal effort to Wafer low", () => {
    const out = waferReasoningTransform({ reasoning_effort: "minimal" });
    expect(out.reasoning_effort).toBe("low");
    expect("thinking" in out).toBe(false);
  });

  it("maps AI SDK xhigh effort to Wafer max", () => {
    const out = waferReasoningTransform({ reasoning_effort: "xhigh" });
    expect(out.reasoning_effort).toBe("max");
    expect("thinking" in out).toBe(false);
  });

  it("does not forward an unsupported string effort to Wafer", () => {
    const out = waferReasoningTransform({ reasoning_effort: "ultra" });
    expect(out.thinking).toEqual({ type: "enabled" });
    expect("reasoning_effort" in out).toBe(false);
  });

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

describe("createWaferRequestTransform", () => {
  it("consumes Promise-valued configuration and request aliases", async () => {
    expect(() =>
      createWaferRequestTransform(
        Promise.reject(new Error("async preservation setting")) as never
      )
    ).toThrow("preserveReasoning must be synchronous");
    const transform = createWaferRequestTransform();
    expect(() =>
      transform({
        preserveReasoning: Promise.reject(
          new Error("async preservation alias")
        ),
        reasoning_effort: "high",
      })
    ).toThrow("reasoning request body fields must be synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("adds both Wafer preserved-reasoning fields when forced and reasoning is enabled", () => {
    const transform = createWaferRequestTransform(true);

    const out = transform({
      model: "Qwen3.5-397B-A17B",
      reasoning_effort: "high",
    });

    expect(out.reasoning_effort).toBe("high");
    expect(out.preserve_thinking).toBe(true);
    expect(out.thinking).toEqual({ type: "enabled", keep: "all" });
  });

  it("does not preserve reasoning when forced but reasoning is disabled", () => {
    const transform = createWaferRequestTransform(true);

    const out = transform({ model: "GLM-5.1", reasoning_effort: "none" });

    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out.preserve_thinking).toBeUndefined();
  });

  it("auto-preserves reasoning only for officially supported models", () => {
    const transform = createWaferRequestTransform("auto");

    const supported = transform({
      model: "GLM-5.1",
      reasoning_effort: "high",
    });
    const unsupported = transform({
      model: "Qwen3.5-397B-A17B",
      reasoning_effort: "high",
    });

    expect(supported.preserve_thinking).toBe(true);
    expect(supported.thinking).toEqual({ type: "enabled", keep: "all" });
    expect(unsupported.preserve_thinking).toBeUndefined();
    expect(unsupported.thinking).toBeUndefined();
  });

  it("lets the call-level preserveReasoning alias override the provider default", () => {
    const transform = createWaferRequestTransform(true);

    const out = transform({
      model: "GLM-5.1",
      preserveReasoning: false,
      reasoning_effort: "high",
    });

    expect("preserveReasoning" in out).toBe(false);
    expect(out.preserve_thinking).toBeUndefined();
    expect(out.reasoning_effort).toBe("high");
  });
});
