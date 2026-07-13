import { describe, expect, it } from "vitest";
import { reasoningMiddleware } from "../reasoning";

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

  it("consumes Promise-valued params, provider options, and provider names", async () => {
    expect(() =>
      transform({
        first: Promise.reject(new Error("async param first")),
        reasoning: "high",
        second: Promise.reject(new Error("async param second")),
      })
    ).toThrow("reasoning request body fields must be synchronous");
    expect(() =>
      transform({
        providerOptions: {
          friendli: Promise.reject(new Error("async provider settings")),
        },
        reasoning: "high",
      })
    ).toThrow("reasoning request body fields must be synchronous");
    expect(() =>
      reasoningMiddleware(
        Promise.reject(new Error("async provider name")) as never
      )
    ).toThrow("reasoning provider name must be synchronous and bounded");
    const hook = reasoningMiddleware("friendli").transformParams;
    expect(() =>
      hook?.(Promise.reject(new Error("async hook arguments")) as never)
    ).toThrow("reasoning request body must be synchronous");
    expect(() =>
      hook?.({
        model: Promise.reject(new Error("async model sibling")),
        params: Promise.reject(new Error("async params")),
        type: "generate",
      } as never)
    ).toThrow("reasoning request body fields must be synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

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
