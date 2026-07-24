import { describe, expect, it } from "vitest";
import { captureProviderConvertUsage } from "../provider-settings-fetch";

describe("captureProviderConvertUsage", () => {
  it("isolates callback input from the SDK-owned usage object", () => {
    const usage = { completion_tokens: 2, prompt_tokens: 1 };
    const captured = captureProviderConvertUsage(
      (capturedUsage) => {
        (capturedUsage as typeof usage).prompt_tokens = 999;
        return {
          inputTokens: { total: 1 },
          outputTokens: { total: 2 },
        } as never;
      },
      "TestProvider",
      {}
    );

    captured?.(usage as never);

    expect(usage.prompt_tokens).toBe(1);
  });

  it("rejects asynchronous callback input without probing thenables", async () => {
    let callbackCalls = 0;
    const captured = captureProviderConvertUsage(
      (() => {
        callbackCalls += 1;
        return {};
      }) as never,
      "TestProvider",
      {}
    );
    const usage = {
      first: Promise.reject(new Error("async usage one")),
      second: Promise.reject(new Error("async usage two")),
    };

    expect(() => captured?.(usage as never)).toThrow(
      "convertUsage input must be bounded JSON"
    );
    expect(callbackCalls).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("preserves the receiver and snapshots nested usage", () => {
    const result = {
      inputTokens: {
        cacheRead: 1,
        cacheWrite: 2,
        noCache: 3,
        total: 6,
      },
      outputTokens: { reasoning: 4, text: 5, total: 9 },
      raw: { stable: true },
    };
    const settings = {
      convertUsage(this: unknown) {
        expect(this).toBe(settings);
        return result;
      },
    };
    const captured = captureProviderConvertUsage(
      settings.convertUsage,
      "TestProvider",
      settings
    );
    const snapshot = captured?.({} as never);
    result.inputTokens.total = 999;
    result.raw.stable = false;

    expect(snapshot).toMatchObject({
      inputTokens: { total: 6 },
      raw: { stable: true },
    });
  });

  it("consumes async usage results and nested token siblings", async () => {
    const asyncResult = captureProviderConvertUsage(
      (() => Promise.reject(new Error("async usage result"))) as never,
      "TestProvider",
      {}
    );
    expect(() => asyncResult?.({} as never)).toThrow(
      "convertUsage must return synchronously"
    );

    const nested = captureProviderConvertUsage(
      () =>
        ({
          inputTokens: {
            cacheRead: Promise.reject(new Error("async cache read")),
            cacheWrite: Promise.reject(new Error("async cache write")),
            noCache: 0,
            total: 0,
          },
          outputTokens: {
            reasoning: Promise.reject(new Error("async reasoning tokens")),
            text: 0,
            total: 0,
          },
        }) as never,
      "TestProvider",
      {}
    );
    expect(() => nested?.({} as never)).toThrow(
      "inputTokens fields must be synchronous"
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects invalid numbers without inspecting thenables", () => {
    const invalid = captureProviderConvertUsage(
      () => ({
        inputTokens: {
          cacheRead: 0,
          cacheWrite: 0,
          noCache: 0,
          total: -1,
        },
        outputTokens: { reasoning: 0, text: 0, total: 0 },
      }),
      "TestProvider",
      {}
    );
    expect(() => invalid?.({} as never)).toThrow(
      "inputTokens.total must be a non-negative finite number"
    );

    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then must not be inspected");
      },
    });
    const thenable = captureProviderConvertUsage(
      () => extension as never,
      "TestProvider",
      {}
    );
    expect(() => thenable?.({} as never)).toThrow(
      "convertUsage inputTokens must be an object"
    );
    expect(thenReads).toBe(0);
  });
});
