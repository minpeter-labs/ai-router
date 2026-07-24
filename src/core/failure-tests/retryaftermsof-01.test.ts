import { describe, expect, it, vi } from "vitest";
import { retryAfterMsOf } from "../failure-retry-after";

describe("retryAfterMsOf", () => {
  it("reads Axios-style nested response headers", () => {
    expect(
      retryAfterMsOf(
        {
          response: {
            headers: { "retry-after": "2" },
          },
        },
        1000
      )
    ).toBe(2000);
  });

  it("reads precise retry-after-ms headers", () => {
    expect(
      retryAfterMsOf(
        {
          responseHeaders: { "retry-after-ms": ["250", "125"] },
        },
        1000
      )
    ).toBe(250);
  });

  it("reads bounded multi-value rate-limit headers without iterators", () => {
    let iterations = 0;
    const retryAfter = ["5", "2"];
    Object.defineProperty(retryAfter, Symbol.iterator, {
      value() {
        iterations += 1;
        throw new Error("iterator must not run");
      },
    });

    expect(
      retryAfterMsOf(
        {
          response: {
            headers: { "retry-after": retryAfter },
          },
        },
        1000
      )
    ).toBe(5000);
    expect(
      retryAfterMsOf(
        {
          headers: {
            get(name: string) {
              return name === "x-ratelimit-reset"
                ? ["bad", "5s", "250ms"]
                : null;
            },
          },
        },
        1000
      )
    ).toBe(5000);
    expect(iterations).toBe(0);
  });

  it("does not coerce hostile multi-value header lengths", () => {
    let coercions = 0;
    const values = new Proxy([], {
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

    expect(
      retryAfterMsOf(
        {
          headers: {
            "retry-after": values,
            "x-ratelimit-reset": "250ms",
          },
        },
        1000
      )
    ).toBe(250);
    expect(coercions).toBe(0);
  });

  it("keeps relative retry hints usable when the wall clock throws", () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("wall clock unavailable");
    });
    try {
      expect(retryAfterMsOf({ headers: { "retry-after": "2" } })).toBe(2000);
      expect(
        retryAfterMsOf({
          headers: { "retry-after": "Thu, 01 Jan 1970 00:00:05 GMT" },
        })
      ).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it("keeps secondary reset hints usable when HTTP-date parsing throws", () => {
    const parse = vi.spyOn(Date, "parse").mockImplementation(() => {
      throw new Error("date parser unavailable");
    });
    try {
      expect(
        retryAfterMsOf(
          {
            headers: {
              "retry-after": "not-a-date",
              "x-ratelimit-reset": "250ms",
            },
          },
          1000
        )
      ).toBe(250);
    } finally {
      parse.mockRestore();
    }
  });

  it("reads plain header objects when the Headers global is unavailable", () => {
    vi.stubGlobal("Headers", undefined);
    try {
      expect(retryAfterMsOf({ headers: { "retry-after": "2" } }, 1000)).toBe(
        2000
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads cross-realm Headers-like objects through their get method", () => {
    const headers = {
      get(name: string) {
        return name === "retry-after" ? "2" : null;
      },
    };
    expect(retryAfterMsOf({ responseHeaders: headers }, 1000)).toBe(2000);
  });

  it("uses the longest combined numeric Retry-After value", () => {
    expect(
      retryAfterMsOf({ headers: { "retry-after": "5, 2, 3.5" } }, 1000)
    ).toBe(5000);
  });

  it("keeps valid numeric Retry-After members beside malformed values", () => {
    expect(
      retryAfterMsOf({ headers: { "retry-after": "bad, 5, 2" } }, 1000)
    ).toBe(5000);
    expect(
      retryAfterMsOf(
        {
          headers: {
            "retry-after": "Thu, 01 Jan 1970 00:00:05 GMT, 2",
          },
        },
        1000
      )
    ).toBe(2000);
  });

  it("uses the longest Retry-After across duplicate header containers", () => {
    expect(
      retryAfterMsOf(
        {
          headers: { "retry-after": "2" },
          responseHeaders: { "retry-after": "5" },
        },
        1000
      )
    ).toBe(5000);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(retryAfterMsOf({ headers: { "retry-after": "2" } }, 1000)).toBe(
      2000
    );
    expect(
      retryAfterMsOf(
        { headers: { "Retry-After": "Thu, 01 Jan 1970 00:00:05 GMT" } },
        1000
      )
    ).toBe(4000);
  });

  it("bounds HTTP-date delays and rejects invalid clocks", () => {
    const error = {
      headers: { "retry-after": "Thu, 01 Jan 1970 00:00:05 GMT" },
    };
    expect(retryAfterMsOf(error, Number.NaN)).toBeUndefined();
    expect(retryAfterMsOf(error, Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(retryAfterMsOf(error, -1)).toBeUndefined();
    expect(retryAfterMsOf(error, Number.MAX_VALUE)).toBeUndefined();
    expect(retryAfterMsOf(error, 1000.5)).toBe(3999.5);
    expect(
      retryAfterMsOf(
        { headers: { "x-ratelimit-reset": "1000000000" } },
        Number.POSITIVE_INFINITY
      )
    ).toBeUndefined();
    expect(
      retryAfterMsOf(
        { headers: { "x-ratelimit-reset": "2s" } },
        Number.POSITIVE_INFINITY
      )
    ).toBe(2000);
    expect(
      retryAfterMsOf({ headers: { "x-ratelimit-reset": "1000000000" } }, -1)
    ).toBeUndefined();
  });
});
