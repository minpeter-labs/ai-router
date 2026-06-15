import { describe, expect, it } from "vitest";

import { createReasoningTransform, reasoningMiddleware } from "./reasoning";

// Pure unit tests for the provider-agnostic reasoning scaffolding. The
// dialect-specific body mappings live with each provider (see
// src/provider/<name>/reasoning.test.ts).

describe("createReasoningTransform", () => {
  // A transform whose applyReasoning records the `enabled` flag it was handed and
  // writes a sentinel into the body, so we can assert the generic behavior
  // (classification, stripping, immutability) independent of any dialect.
  function makeSpy() {
    const calls: boolean[] = [];
    const transform = createReasoningTransform((body, enabled) => {
      calls.push(enabled);
      body.applied = enabled;
    });
    return { calls, transform };
  }

  describe("classifies reasoning_effort into enabled and strips the field", () => {
    for (const effort of [
      "low",
      "medium",
      "high",
      "minimal",
      "xhigh",
    ] as const) {
      it(`'${effort}' -> enabled=true`, () => {
        const { calls, transform } = makeSpy();
        const out = transform({ model: "m", reasoning_effort: effort });
        expect(calls).toEqual([true]);
        expect(out.applied).toBe(true);
        expect("reasoning_effort" in out).toBe(false);
      });
    }

    it("true -> enabled=true", () => {
      const { calls, transform } = makeSpy();
      const out = transform({ reasoning_effort: true });
      expect(calls).toEqual([true]);
      expect("reasoning_effort" in out).toBe(false);
    });

    it("'none' -> enabled=false", () => {
      const { calls, transform } = makeSpy();
      const out = transform({ reasoning_effort: "none" });
      expect(calls).toEqual([false]);
      expect(out.applied).toBe(false);
      expect("reasoning_effort" in out).toBe(false);
    });

    it("false -> enabled=false", () => {
      const { calls, transform } = makeSpy();
      const out = transform({ reasoning_effort: false });
      expect(calls).toEqual([false]);
      expect("reasoning_effort" in out).toBe(false);
    });
  });

  describe("absent / nullish reasoning_effort -> untouched clone, applyReasoning not called", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["absent", { model: "m", messages: [{ role: "user", content: "hi" }] }],
      ["explicit undefined", { model: "m", reasoning_effort: undefined }],
      ["null", { model: "m", reasoning_effort: null }],
    ];

    for (const [label, input] of cases) {
      it(`${label}: returns a deep-equal new object, applyReasoning not called`, () => {
        const { calls, transform } = makeSpy();
        const out = transform(input);
        expect(out).toEqual(input);
        expect(out).not.toBe(input);
        expect(calls).toEqual([]);
      });
    }
  });

  describe("immutability", () => {
    it("does not mutate the input; returns a new reference", () => {
      const { transform } = makeSpy();
      const input = { model: "m", reasoning_effort: "high" };
      const out = transform(input);
      expect(input.reasoning_effort).toBe("high");
      expect("applied" in input).toBe(false);
      expect(out).not.toBe(input);
    });
  });
});

// Unit tests for the `reasoningMiddleware` transformParams hook. It runs on the
// call options (where `reasoning` still carries 'none') and promotes that value
// into `providerOptions.<name>.reasoningEffort` so the downstream body keeps it.
describe("reasoningMiddleware", () => {
  const transform = (params: Record<string, unknown>, name = "friendli") => {
    const { transformParams } = reasoningMiddleware(name);
    // transformParams is the only hook this middleware defines.
    if (!transformParams) {
      throw new Error("transformParams is not defined");
    }
    return transformParams({
      params,
      type: "generate",
      model: {},
    } as unknown as Parameters<typeof transformParams>[0]);
  };

  for (const reasoning of [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ] as const) {
    it(`promotes reasoning '${reasoning}' into providerOptions.<name>.reasoningEffort`, async () => {
      const out = await transform({ reasoning });
      expect(out.providerOptions).toEqual({
        friendli: { reasoningEffort: reasoning },
      });
      // The original `reasoning` option is left in place; providerOptions wins downstream.
      expect(out.reasoning).toBe(reasoning);
    });
  }

  it("uses the provider name as the providerOptions key", async () => {
    const out = await transform({ reasoning: "none" }, "openrouter");
    expect(out.providerOptions).toEqual({
      openrouter: { reasoningEffort: "none" },
    });
  });

  it("merges into existing providerOptions for other providers", async () => {
    const out = await transform({
      reasoning: "high",
      providerOptions: { openrouter: { somethingElse: true } },
    });
    expect(out.providerOptions).toEqual({
      openrouter: { somethingElse: true },
      friendli: { reasoningEffort: "high" },
    });
  });

  it("preserves other keys already under the same provider", async () => {
    const out = await transform({
      reasoning: "low",
      providerOptions: { friendli: { user: "u" } },
    });
    expect(out.providerOptions).toEqual({
      friendli: { user: "u", reasoningEffort: "low" },
    });
  });

  it("does not clobber an explicit reasoningEffort", async () => {
    const params = {
      reasoning: "high",
      providerOptions: { friendli: { reasoningEffort: "none" } },
    };
    const out = await transform(params);
    expect(out.providerOptions).toEqual({
      friendli: { reasoningEffort: "none" },
    });
    // Returned verbatim — nothing to promote.
    expect(out).toBe(params);
  });

  for (const reasoning of [undefined, "provider-default"] as const) {
    it(`leaves params untouched when reasoning is ${reasoning ?? "absent"}`, async () => {
      const params =
        reasoning === undefined ? { foo: 1 } : { reasoning, foo: 1 };
      const out = await transform(params);
      expect(out).toBe(params);
      expect("providerOptions" in out).toBe(false);
    });
  }

  it("does not mutate the input params", async () => {
    const params: Record<string, unknown> = {
      reasoning: "high",
      providerOptions: { friendli: { user: "u" } },
    };
    await transform(params);
    expect(params.providerOptions).toEqual({ friendli: { user: "u" } });
  });
});
