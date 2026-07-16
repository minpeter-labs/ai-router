import { describe, expect, it } from "vitest";
import { retryAfterMsOf } from "../failure-retry-after";

describe("retryAfterMsOf", () => {
  it("falls back to own fields when a Headers-like getter is unusable", () => {
    let enumerations = 0;
    const headers = new Proxy(
      {
        "retry-after": ["5", "2"],
        get() {
          throw new Error("native lookup unavailable");
        },
      },
      {
        ownKeys(target) {
          enumerations += 1;
          return Reflect.ownKeys(target);
        },
      }
    );

    expect(retryAfterMsOf({ responseHeaders: headers }, 1000)).toBe(5000);
    expect(enumerations).toBe(0);
  });

  it("snapshots an aliased header container only once", () => {
    let getterReads = 0;
    let calls = 0;
    const headers = Object.defineProperty({}, "get", {
      get() {
        getterReads += 1;
        return (name: string) => {
          calls += 1;
          return name === "x-ratelimit-reset" ? "250ms" : null;
        };
      },
    });

    expect(retryAfterMsOf({ headers, responseHeaders: headers }, 1000)).toBe(
      250
    );
    expect(getterReads).toBe(1);
    expect(calls).toBe(6);
  });

  it("snapshots canonical plain headers without enumerating their keys", () => {
    let ownKeysReads = 0;
    let valueReads = 0;
    const headers = new Proxy(
      { "X-RateLimit-Reset-Tokens": "125ms" },
      {
        get(target, key, receiver) {
          if (key === "X-RateLimit-Reset-Tokens") {
            valueReads += 1;
          }
          return Reflect.get(target, key, receiver);
        },
        ownKeys(target) {
          ownKeysReads += 1;
          if (ownKeysReads > 1) {
            throw new Error("headers enumerated twice");
          }
          return Reflect.ownKeys(target);
        },
      }
    );

    expect(retryAfterMsOf({ responseHeaders: headers }, 1000)).toBe(125);
    expect(ownKeysReads).toBe(0);
    expect(valueReads).toBe(0);
  });

  it("retains exact lowercase lookup without structural enumeration", () => {
    let valueReads = 0;
    const headers = new Proxy(
      { "retry-after": "2" },
      {
        get(target, key, receiver) {
          if (key === "retry-after") {
            valueReads += 1;
          }
          return Reflect.get(target, key, receiver);
        },
        ownKeys() {
          throw new Error("header enumeration unavailable");
        },
      }
    );

    expect(retryAfterMsOf({ responseHeaders: headers }, 1000)).toBe(2000);
    expect(valueReads).toBe(0);
  });

  it("does not re-read an unusable exact lowercase header getter", () => {
    let reads = 0;
    const headers = Object.defineProperties(
      { "x-ratelimit-reset": "250ms" },
      {
        "retry-after": {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error("retry-after unavailable");
          },
        },
      }
    );

    expect(retryAfterMsOf({ headers }, 1000)).toBe(250);
    expect(reads).toBe(0);
  });

  it("does not execute inherited or own plain-header accessors", () => {
    let reads = 0;
    const prototype = Object.defineProperty({}, "retry-after", {
      enumerable: true,
      get() {
        reads += 1;
        return "10";
      },
    });
    const headers = Object.create(prototype) as Record<string, unknown>;
    Object.defineProperty(headers, "Retry-After", {
      enumerable: true,
      get() {
        reads += 1;
        return "5";
      },
    });
    headers["X-RateLimit-Reset"] = "250ms";

    expect(retryAfterMsOf({ headers }, 1000)).toBe(250);
    expect(reads).toBe(0);
  });

  it("isolates a revoked Proxy header value and keeps secondary hints", () => {
    const revoked = Proxy.revocable<string[]>([], {});
    revoked.revoke();

    expect(() =>
      retryAfterMsOf(
        {
          headers: {
            "retry-after": revoked.proxy,
            "x-ratelimit-reset": "250ms",
          },
        },
        1000
      )
    ).not.toThrow();
    expect(
      retryAfterMsOf(
        {
          headers: {
            "retry-after": revoked.proxy,
            "x-ratelimit-reset": "250ms",
          },
        },
        1000
      )
    ).toBe(250);
  });

  it("ignores negative or malformed values and preserves finite delays", () => {
    expect(
      retryAfterMsOf(
        {
          headers: {
            "retry-after": "-1",
            "x-ratelimit-reset": "2s",
          },
        },
        1000
      )
    ).toBe(2000);
    expect(
      retryAfterMsOf({ headers: { "x-ratelimit-reset": "5 bananas" } }, 0)
    ).toBeUndefined();
    expect(
      retryAfterMsOf({ headers: { "x-ratelimit-reset": "1e308s" } }, 0)
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});
