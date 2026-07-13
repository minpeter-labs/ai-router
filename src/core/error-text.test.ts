import { describe, expect, it } from "vitest";
import { boundedErrorText, boundedProviderErrorText } from "./error-text";

describe("boundedErrorText", () => {
  it("extracts nested text from circular objects", () => {
    const body: Record<string, unknown> = {
      error: { code: "insufficient_quota", message: "credits exhausted" },
    };
    body.circular = body;

    const text = boundedErrorText(body);
    expect(text).toContain("insufficient_quota");
    expect(text).toContain("credits exhausted");
  });

  it("bounds large values and ignores throwing getters", () => {
    const body = Object.defineProperty(
      { message: "x".repeat(100_000), safe: "still readable" },
      "hostile",
      {
        enumerable: true,
        get() {
          throw new Error("getter failed");
        },
      }
    );

    const text = boundedErrorText(body, 1024);
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(() => boundedErrorText(body)).not.toThrow();
  });

  it("normalizes non-finite and fractional character limits", () => {
    expect(
      boundedErrorText("x".repeat(100_000), Number.POSITIVE_INFINITY)
    ).toHaveLength(16_384);
    expect(boundedErrorText("abcdef", 3.9)).toBe("abc");
    expect(boundedErrorText("abcdef", -1)).toBe("");
  });

  it("retains the tail of oversized provider strings", () => {
    const text = boundedErrorText(`${"x".repeat(10_000)} quota exceeded`, 100);
    expect(text).toContain("quota exceeded");
    expect(text.length).toBeLessThanOrEqual(100);
  });

  it("does not split Unicode surrogate pairs at truncation boundaries", () => {
    const short = boundedErrorText(`${"a".repeat(8)}😀tail`, 9);
    const headAndTail = boundedErrorText(
      `${"😀".repeat(100)} quota exceeded 😀`,
      100
    );

    expect(() => encodeURIComponent(short)).not.toThrow();
    expect(() => encodeURIComponent(headAndTail)).not.toThrow();
    expect(short.length).toBeLessThanOrEqual(9);
    expect(headAndTail.length).toBeLessThanOrEqual(100);
    expect(headAndTail).toContain("quota exceeded");
  });

  it("ignores throwing Error identity accessors", () => {
    const error = new Error("hidden");
    let reads = 0;
    Object.defineProperties(error, {
      message: {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error("message getter failed");
        },
      },
      name: {
        get() {
          reads += 1;
          throw new Error("name getter failed");
        },
      },
      statusCode: { enumerable: true, value: 503 },
    });

    expect(() => boundedErrorText(error)).not.toThrow();
    expect(boundedErrorText(error)).toContain("503");
    expect(reads).toBe(0);
  });

  it("survives proxies that throw during Error prototype checks", () => {
    const hostile = new Proxy(
      { message: "provider overloaded", statusCode: 503 },
      {
        getPrototypeOf() {
          throw new Error("prototype unavailable");
        },
      }
    );

    expect(() => boundedErrorText(hostile)).not.toThrow();
    expect(boundedErrorText(hostile)).toContain("provider overloaded");
  });

  it("extracts properties from callable provider errors", () => {
    const callable = Object.assign(() => undefined, {
      message: "callable provider failure",
      statusCode: 429,
    });

    expect(boundedErrorText(callable)).toContain("callable provider failure");
    expect(boundedErrorText(callable)).toContain("429");
  });

  it("does not enumerate arbitrary or inherited generic error fields", () => {
    let ownKeyReads = 0;
    let inheritedReads = 0;
    const prototype = Object.defineProperty({}, "message", {
      enumerable: true,
      get() {
        inheritedReads += 1;
        return "inherited secret";
      },
    });
    const target = Object.assign(Object.create(prototype), {
      arbitrary: "must not be scanned",
      code: "rate_limit_error",
    });
    const error = new Proxy(target, {
      ownKeys() {
        ownKeyReads += 1;
        throw new Error("generic keys must not be enumerated");
      },
    });

    const text = boundedErrorText(error);
    expect(text).toContain("rate_limit_error");
    expect(text).not.toContain("must not be scanned");
    expect(text).not.toContain("inherited secret");
    expect(ownKeyReads).toBe(0);
    expect(inheritedReads).toBe(0);
  });

  it("consumes Promise-valued diagnostics without reading thenables", async () => {
    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    const error = {
      body: Promise.reject(new Error("async body diagnostic")),
      data: Promise.reject(new Error("async data diagnostic")),
      message: Promise.reject(new Error("async message diagnostic")),
      response: { error: thenable },
    };

    expect(() => boundedErrorText(error, 1)).not.toThrow();
    expect(() => boundedProviderErrorText(error, 1)).not.toThrow();
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("boundedProviderErrorText", () => {
  it("keeps semantic error fields while excluding echoed request fields", () => {
    const text = boundedProviderErrorText({
      error: { code: "model_not_available", message: "model unavailable" },
      input: "insufficient credits",
      prompt: "invalid_api_key",
      request: { message: "quota exceeded" },
    });

    expect(text).toContain("model_not_available");
    expect(text).toContain("model unavailable");
    expect(text).not.toContain("insufficient credits");
    expect(text).not.toContain("invalid_api_key");
    expect(text).not.toContain("quota exceeded");
  });

  it("filters bounded JSON bodies but preserves plain-text errors", () => {
    expect(
      boundedProviderErrorText(
        JSON.stringify({
          error: { message: "provider overloaded" },
          prompt: "model not available",
        })
      )
    ).toContain("provider overloaded");
    expect(
      boundedProviderErrorText(
        JSON.stringify({
          error: { message: "provider overloaded" },
          prompt: "model not available",
        })
      )
    ).not.toContain("model not available");
    expect(boundedProviderErrorText("plain provider failure")).toBe(
      "plain provider failure"
    );
    expect(
      boundedProviderErrorText(JSON.stringify([{ code: "insufficient_quota" }]))
    ).toContain("insufficient_quota");
  });

  it("does not fall back to scanning malformed or oversized JSON-like bodies", () => {
    expect(boundedProviderErrorText('{"prompt":"model not available"')).toBe(
      ""
    );
    expect(
      boundedProviderErrorText(
        JSON.stringify({ prompt: `invalid_api_key${"x".repeat(70_000)}` })
      )
    ).toBe("");
  });

  it("keeps semantic filtering when a Proxy rejects enumeration", () => {
    let enumerationAttempts = 0;
    const body = new Proxy(
      {
        data: "invalid_api_key",
        message: "provider overloaded",
      },
      {
        ownKeys() {
          enumerationAttempts += 1;
          throw new Error("enumeration unavailable");
        },
      }
    );

    const text = boundedProviderErrorText(body);
    expect(text).toContain("provider overloaded");
    expect(text).not.toContain("invalid_api_key");
    expect(enumerationAttempts).toBe(0);
  });

  it("does not coerce hostile semantic array lengths", () => {
    let coercions = 0;
    const errors = new Proxy([], {
      get(target, key, receiver) {
        if (key === "length") {
          return {
            valueOf() {
              coercions += 1;
              return 1;
            },
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });

    expect(() => boundedProviderErrorText({ errors })).not.toThrow();
    expect(coercions).toBe(0);
  });

  it("isolates revoked semantic container brands", () => {
    const revoked = Proxy.revocable<Record<string, unknown>>(
      { error: { message: "hidden" } },
      {}
    );
    revoked.revoke();

    expect(() => boundedProviderErrorText(revoked.proxy)).not.toThrow();
    expect(boundedProviderErrorText(revoked.proxy)).toBe("");
  });

  it("does not execute semantic field or array-index accessors", () => {
    let reads = 0;
    const error = Object.defineProperty(
      { code: "rate_limit_error" },
      "message",
      {
        get() {
          reads += 1;
          return "must not run";
        },
      }
    );
    const errors = [{ code: "insufficient_quota" }, error];
    Object.defineProperty(errors, 0, {
      configurable: true,
      get() {
        reads += 1;
        return { code: "must_not_run" };
      },
    });

    const text = boundedProviderErrorText({ errors });
    expect(text).toContain("rate_limit_error");
    expect(text).not.toContain("must_not_run");
    expect(reads).toBe(0);
  });

  it("prioritizes core error fields over verbose descriptions", () => {
    const text = boundedProviderErrorText(
      {
        description: "x".repeat(100_000),
        error: { code: "insufficient_quota", message: "credits exhausted" },
      },
      256
    );

    expect(text).toContain("insufficient_quota");
    expect(text).toContain("credits exhausted");
  });

  it("traverses object wrappers without admitting primitive wrapper echoes", () => {
    const text = boundedProviderErrorText({
      body: "invalid_api_key",
      data: {
        error: { code: "insufficient_quota", message: "credits exhausted" },
        prompt: "model not available",
      },
      response: { data: { prompt: "Cloudflare WAF rejected" } },
    });

    expect(text).toContain("insufficient_quota");
    expect(text).toContain("credits exhausted");
    expect(text).not.toContain("invalid_api_key");
    expect(text).not.toContain("model not available");
    expect(text).not.toContain("Cloudflare WAF rejected");
  });

  it("filters valid JSON strings nested inside response wrappers", () => {
    expect(
      boundedProviderErrorText({
        response: {
          data: JSON.stringify({
            error: { code: "model_not_available" },
            prompt: "invalid_api_key",
          }),
        },
      })
    ).toContain("model_not_available");
    expect(
      boundedProviderErrorText({
        response: {
          data: JSON.stringify({ prompt: "invalid_api_key" }),
        },
      })
    ).not.toContain("invalid_api_key");
  });

  it("bounds aggregate nested wrapper JSON parsing", () => {
    const padding = " ".repeat(40_000);
    const text = boundedProviderErrorText({
      body: `{"error":{"message":"first wrapper"}}${padding}`,
      data: `{"error":{"code":"insufficient_quota"}}${padding}`,
    });

    expect(text).toContain("first wrapper");
    expect(text).not.toContain("insufficient_quota");
  });
});
