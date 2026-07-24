import { describe, expect, it } from "vitest";
import { createReasoningTransform } from "../reasoning";

describe("createReasoningTransform", () => {
  it("consumes Promise-valued request fields and async apply results", async () => {
    const transform = createReasoningTransform((() =>
      Promise.reject(new Error("async apply result"))) as never);
    expect(() =>
      transform({
        first: Promise.reject(new Error("async body first")),
        reasoning_effort: "high",
        second: Promise.reject(new Error("async body second")),
      })
    ).toThrow("reasoning request body fields must be synchronous");
    expect(() => transform({ reasoning_effort: "high" })).toThrow(
      "applyReasoning must return synchronously"
    );
    expect(() =>
      createReasoningTransform(
        Promise.reject(new Error("async apply slot")) as never
      )
    ).toThrow("applyReasoning must be a synchronous function");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not inspect arbitrary thenable body extensions", () => {
    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then must not be inspected");
      },
    });
    const { transform } = makeSpy();

    expect(transform({ extension })).toEqual({ extension });
    expect(thenReads).toBe(0);
  });

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
