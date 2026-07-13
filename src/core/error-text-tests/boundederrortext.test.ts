import { describe, expect, it } from "vitest";
import { boundedErrorText, boundedProviderErrorText } from "../error-text";

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
