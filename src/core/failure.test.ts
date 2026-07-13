import { describe, expect, it, vi } from "vitest";
import {
  defaultClassifyFailure,
  isTerminalRequestFailure,
  normalizeFailureClassification,
  retryAfterMsOf,
} from "./failure";

describe("normalizeFailureClassification", () => {
  it("consumes Promise-valued classification siblings", async () => {
    expect(() =>
      normalizeFailureClassification({
        cooldownMs: Promise.reject(new Error("async cooldown")),
        retryAfterMs: Promise.reject(new Error("async retry delay")),
        retryable: Promise.reject(new Error("async retryable")),
        scope: Promise.reject(new Error("async scope")),
        statusCode: Promise.reject(new Error("async status")),
      })
    ).toThrow("synchronous");
    expect(
      isTerminalRequestFailure({
        code: Promise.reject(new Error("async terminal code")),
      })
    ).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not inspect arbitrary thenable classification fields", () => {
    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });

    expect(() =>
      normalizeFailureClassification({
        retryable: thenable,
        scope: "transient",
      })
    ).toThrow("invalid failure classification");
    expect(thenReads).toBe(0);
  });
});

describe("defaultClassifyFailure", () => {
  it("reads shared retry and scope fields once", () => {
    const reads = new Map<string, number>();
    const values: Record<string, unknown> = {
      body: { error: "temporary" },
      code: "UPSTREAM",
      data: { retry: true },
      message: "temporarily unavailable",
      responseBody: "retry later",
      statusCode: 503,
    };
    const error = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          {
            get() {
              reads.set(key, (reads.get(key) ?? 0) + 1);
              return value;
            },
          },
        ])
      )
    );

    expect(defaultClassifyFailure(error)).toMatchObject({
      retryable: true,
      scope: "transient",
      statusCode: 503,
    });
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(reads.size).toBe(Object.keys(values).length);
  });

  it("uses a valid status alias after a malformed statusCode", () => {
    expect(
      defaultClassifyFailure({ status: 429, statusCode: "ERR_RATE_LIMIT" })
    ).toMatchObject({
      retryable: true,
      scope: "credential",
      statusCode: 429,
    });
  });

  it("uses a valid status alias after an out-of-range statusCode", () => {
    expect(
      defaultClassifyFailure({ status: 429, statusCode: 999 })
    ).toMatchObject({
      retryable: true,
      scope: "credential",
      statusCode: 429,
    });
  });

  it("classifies credential and routing-unit failures", () => {
    expect(defaultClassifyFailure({ statusCode: 429 })).toMatchObject({
      retryable: true,
      scope: "credential",
    });
    expect(defaultClassifyFailure({ statusCode: 422 })).toMatchObject({
      retryable: true,
      scope: "routing-unit",
    });
    expect(defaultClassifyFailure({ statusCode: 412 })).toMatchObject({
      retryable: true,
      scope: "credential",
    });
  });

  it("classifies connection-specific HTTP failures as transient", () => {
    for (const statusCode of [421, 425]) {
      expect(defaultClassifyFailure({ statusCode })).toMatchObject({
        retryable: true,
        scope: "transient",
        statusCode,
      });
    }
  });

  it("classifies callable provider failures with headers", () => {
    const callable = Object.assign(() => undefined, {
      headers: { "retry-after": "2" },
      message: "rate limited",
      statusCode: 429,
    });

    expect(defaultClassifyFailure(callable)).toMatchObject({
      retryable: true,
      retryAfterMs: 2000,
      scope: "credential",
      statusCode: 429,
    });
  });

  it("distinguishes hard auth failures from quota-like credential failures", () => {
    expect(
      defaultClassifyFailure({ statusCode: 403, message: "invalid api key" })
    ).toMatchObject({ cooldownMs: 3_600_000, scope: "credential" });
    const quota = defaultClassifyFailure({
      statusCode: 403,
      message: "monthly quota exceeded",
    });
    expect(quota).toMatchObject({ scope: "credential" });
    expect(quota.cooldownMs).toBeUndefined();
  });

  it("recognizes credential exhaustion carried by unusual statuses", () => {
    expect(
      defaultClassifyFailure({
        statusCode: 404,
        responseBody: { error: { message: "insufficient credits" } },
      })
    ).toMatchObject({ retryable: true, scope: "credential" });
    expect(
      defaultClassifyFailure({
        statusCode: 503,
        message: "Missing upstream credential env",
      })
    ).toMatchObject({ cooldownMs: 3_600_000, scope: "credential" });
  });

  it("recognizes common 503 missing-credential phrasings", () => {
    for (const message of [
      "no upstream credentials available",
      "upstream API key is missing",
      "provider credential not configured",
    ]) {
      expect(
        defaultClassifyFailure({ message, statusCode: 503 })
      ).toMatchObject({
        cooldownMs: 3_600_000,
        retryable: true,
        scope: "credential",
      });
    }
  });

  it("classifies common 404 credit exhaustion phrasings as credential-scoped", () => {
    for (const message of [
      "not enough credits",
      "credit balance is too low",
      "account has run out of funds",
      "credits depleted",
      "credits exhausted",
      "quota exceeded",
    ]) {
      expect(
        defaultClassifyFailure({ message, statusCode: 404 })
      ).toMatchObject({
        retryable: true,
        scope: "credential",
      });
    }
  });

  it("classifies a circular provider response body without full serialization", () => {
    const responseBody: Record<string, unknown> = {
      error: { message: "insufficient credits" },
    };
    responseBody.circular = responseBody;

    expect(
      defaultClassifyFailure({ statusCode: 404, responseBody })
    ).toMatchObject({ retryable: true, scope: "credential" });
  });

  it("fails closed for an unreadable status while isolating header getters", () => {
    const headers = Object.defineProperty({}, "Retry-After", {
      enumerable: true,
      get() {
        throw new Error("header getter failed");
      },
    });
    const error = Object.defineProperty(
      { headers, message: "transport failure" },
      "statusCode",
      {
        enumerable: true,
        get() {
          throw new Error("status getter failed");
        },
      }
    );

    expect(() => defaultClassifyFailure(error)).not.toThrow();
    expect(defaultClassifyFailure(error)).toMatchObject({
      retryable: false,
      scope: "request",
    });
  });

  it("ignores a proxied Headers object that throws during native lookup", () => {
    const headers = new Proxy(new Headers({ "retry-after": "2" }), {
      get() {
        throw new Error("headers proxy failed");
      },
    });

    expect(() =>
      defaultClassifyFailure({ headers, statusCode: 503 })
    ).not.toThrow();
    expect(defaultClassifyFailure({ headers, statusCode: 503 })).toMatchObject({
      retryable: true,
      scope: "transient",
      statusCode: 503,
    });
  });

  it("treats a permanently invalid provider model as a routing-unit fault", () => {
    expect(defaultClassifyFailure({ code: "invalid_provider_model" })).toEqual({
      cooldownMs: 3_600_000,
      retryable: true,
      scope: "routing-unit",
    });
  });

  it("keeps unrelated 404 failures request-scoped and terminal", () => {
    expect(
      defaultClassifyFailure({ statusCode: 404, message: "job not found" })
    ).toMatchObject({ retryable: false, scope: "request" });
    expect(
      defaultClassifyFailure({
        responseBody: {
          invalid_api_key: false,
          model_not_available: false,
        },
        statusCode: 404,
      })
    ).toEqual({ retryable: false, scope: "request", statusCode: 404 });
    for (const responseBody of [
      { prompt: "Why is model x not available?" },
      JSON.stringify({ prompt: "Why is model x not available?" }),
      '{"prompt":"model not available"',
      JSON.stringify({
        prompt: `model not available${"x".repeat(70_000)}`,
      }),
    ]) {
      expect(
        defaultClassifyFailure({
          message: "job not found",
          responseBody,
          statusCode: 404,
        })
      ).toEqual({ retryable: false, scope: "request", statusCode: 404 });
    }
  });

  it("classifies no-endpoint model 404s as routing-unit failures", () => {
    expect(
      defaultClassifyFailure({
        message: "No endpoints found for the requested model",
        statusCode: 404,
      })
    ).toMatchObject({
      retryable: true,
      scope: "routing-unit",
      statusCode: 404,
    });
  });

  it("keeps provider and model availability failures routing-unit scoped", () => {
    for (const [statusCode, message] of [
      [403, "The requested provider 'deepinfra' is not available."],
      [403, "The requested model is not available on this endpoint."],
      [404, "The requested provider 'deepinfra' is not available."],
      [
        403,
        "Requested model is not supported by any provider you have enabled",
      ],
      [403, "Unable to access model; see supported models"],
      [403, "upstream_waf_blocked"],
      [403, "Cloudflare WAF rejected the upstream request"],
    ] as const) {
      expect(defaultClassifyFailure({ message, statusCode })).toMatchObject({
        retryable: true,
        scope: "routing-unit",
        statusCode,
      });
    }
  });

  it("does not treat gateway WAF blocks as hard credential failures", () => {
    for (const message of ["upstream_waf_blocked", "Cloudflare WAF block"]) {
      const classification = defaultClassifyFailure({
        message,
        statusCode: 403,
      });
      expect(classification).toMatchObject({
        retryable: true,
        scope: "routing-unit",
      });
      expect(classification.cooldownMs).toBeUndefined();
    }
  });

  it("does not infer a WAF block from an echoed product name alone", () => {
    expect(
      defaultClassifyFailure({
        message: "forbidden",
        responseBody: { prompt: "Explain Cloudflare WAF" },
        statusCode: 403,
      })
    ).toMatchObject({
      cooldownMs: 3_600_000,
      retryable: true,
      scope: "credential",
    });
  });

  it("classifies model plan-access 404s as credential failures", () => {
    for (const message of [
      "Model x is not available on your subscription plan",
      "Model x does not exist for pay-as-you-go accounts",
      "Model x is not available on the current plan",
    ]) {
      expect(
        defaultClassifyFailure({ message, statusCode: 404 })
      ).toMatchObject({
        retryable: true,
        scope: "credential",
        statusCode: 404,
      });
    }
  });

  it("classifies proxy budget exhaustion as a credential failure", () => {
    expect(
      defaultClassifyFailure({
        message:
          "ExceededBudget: User is over budget. Spend=10.00, Budget=10.00",
        statusCode: 400,
      })
    ).toMatchObject({
      retryable: true,
      scope: "credential",
      statusCode: 400,
    });
    expect(
      defaultClassifyFailure({
        message: "Billing or monthly spending limit reached",
        statusCode: 403,
      })
    ).toMatchObject({
      retryable: true,
      scope: "credential",
    });
    expect(
      defaultClassifyFailure({
        message: "Billing or monthly spending limit reached",
        statusCode: 403,
      })
    ).not.toHaveProperty("cooldownMs", 3_600_000);
  });

  it("classifies structured provider exhaustion codes as credential failures", () => {
    expect(
      defaultClassifyFailure({
        responseBody: { error: { code: "insufficient_quota" } },
        statusCode: 404,
      })
    ).toMatchObject({ retryable: true, scope: "credential" });
    expect(
      defaultClassifyFailure({
        responseBody: { error: { code: "access_terminated_error" } },
        statusCode: 404,
      })
    ).toMatchObject({
      cooldownMs: 3_600_000,
      retryable: true,
      scope: "credential",
    });
  });

  it("applies the hard-auth floor to explicit auth codes on odd statuses", () => {
    for (const code of [
      "invalid_api_key",
      "authentication_error",
      "invalid_token",
      "api_key_disabled",
    ]) {
      expect(
        defaultClassifyFailure({
          responseBody: { error: { code } },
          statusCode: 400,
        })
      ).toMatchObject({
        cooldownMs: 3_600_000,
        retryable: true,
        scope: "credential",
      });
    }
    expect(defaultClassifyFailure({ code: "invalid_api_key" })).toMatchObject({
      cooldownMs: 3_600_000,
      retryable: true,
      scope: "credential",
    });
  });

  it("keeps explicit model-unavailable codes routing-unit scoped", () => {
    expect(
      defaultClassifyFailure({
        responseBody: { error: { code: "model_not_found" } },
        statusCode: 410,
      })
    ).toMatchObject({
      retryable: true,
      scope: "routing-unit",
      statusCode: 410,
    });
    expect(
      defaultClassifyFailure({
        code: "model_not_available",
        statusCode: 410,
      })
    ).toMatchObject({ retryable: true, scope: "routing-unit" });
    expect(
      defaultClassifyFailure({ code: "model_not_available" })
    ).toMatchObject({ retryable: true, scope: "routing-unit" });
  });

  it("reads semantic failures through Axios-style response wrappers", () => {
    expect(
      defaultClassifyFailure({
        response: {
          data: { error: { code: "model_not_available" } },
        },
        statusCode: 404,
      })
    ).toMatchObject({
      retryable: true,
      scope: "routing-unit",
      statusCode: 404,
    });
    expect(
      defaultClassifyFailure({
        response: {
          data: { error: { code: "insufficient_quota" } },
        },
        statusCode: 404,
      })
    ).toMatchObject({
      retryable: true,
      scope: "credential",
      statusCode: 404,
    });
    expect(
      defaultClassifyFailure({
        response: {
          data: JSON.stringify({
            error: { code: "model_not_available" },
          }),
        },
        statusCode: 404,
      })
    ).toMatchObject({ retryable: true, scope: "routing-unit" });
  });

  it("uses Axios-style nested response statuses for health scope", () => {
    expect(defaultClassifyFailure({ response: { status: 429 } })).toMatchObject(
      {
        retryable: true,
        scope: "credential",
        statusCode: 429,
      }
    );
    expect(
      defaultClassifyFailure({
        response: {
          data: { error: { code: "model_not_available" } },
          status: 404,
        },
      })
    ).toMatchObject({
      retryable: true,
      scope: "routing-unit",
      statusCode: 404,
    });
  });

  it("reads an Axios response container once", () => {
    let reads = 0;
    const error = Object.defineProperty({}, "response", {
      get() {
        reads += 1;
        return {
          data: { error: { code: "insufficient_quota" } },
          headers: { "retry-after": "2" },
          status: 429,
        };
      },
    });

    expect(defaultClassifyFailure(error)).toMatchObject({
      retryable: true,
      retryAfterMs: 2000,
      scope: "credential",
      statusCode: 429,
    });
    expect(reads).toBe(1);
  });

  it("classifies a one-level wrapped provider cause", () => {
    expect(
      defaultClassifyFailure({
        cause: {
          data: { error: { code: "insufficient_quota" } },
          responseHeaders: { "retry-after-ms": "125" },
          statusCode: 429,
        },
        message: "gateway request failed",
      })
    ).toMatchObject({
      retryable: true,
      retryAfterMs: 125,
      scope: "credential",
      statusCode: 429,
    });
  });

  it("keeps valid top-level retry headers authoritative over a cause", () => {
    expect(
      retryAfterMsOf(
        {
          cause: { responseHeaders: { "retry-after-ms": "125" } },
          responseHeaders: { "retry-after": "2" },
        },
        1000
      )
    ).toBe(2000);
    expect(
      retryAfterMsOf(
        {
          cause: { responseHeaders: { "retry-after-ms": "125" } },
          responseHeaders: { "retry-after": "invalid" },
        },
        1000
      )
    ).toBe(125);
  });

  it("does not recapture an aliased header container across cause tiers", () => {
    let getReads = 0;
    const headers = Object.defineProperty({}, "get", {
      get() {
        getReads += 1;
        return (name: string) => (name === "retry-after" ? "2" : null);
      },
    });

    expect(
      retryAfterMsOf(
        {
          cause: { responseHeaders: headers },
          responseHeaders: headers,
        },
        1000
      )
    ).toBe(2000);
    expect(getReads).toBe(1);
  });

  it("keeps a valid top-level status authoritative over its cause", () => {
    let causeCodeReads = 0;
    expect(
      defaultClassifyFailure({
        cause: Object.defineProperty(
          {
            data: { error: { code: "insufficient_quota" } },
            statusCode: 429,
          },
          "code",
          {
            get() {
              causeCodeReads += 1;
              return "insufficient_quota";
            },
          }
        ),
        message: "job not found",
        statusCode: 404,
      })
    ).toEqual({ retryable: false, scope: "request", statusCode: 404 });
    expect(causeCodeReads).toBe(0);
  });

  it("captures wrapped cause containers once", () => {
    let causeReads = 0;
    let responseReads = 0;
    const cause = Object.defineProperty(
      {
        responseHeaders: { "retry-after": "2" },
        statusCode: 429,
      },
      "response",
      {
        get() {
          responseReads += 1;
          return;
        },
      }
    );
    const error = Object.defineProperty({}, "cause", {
      get() {
        causeReads += 1;
        return cause;
      },
    });

    expect(defaultClassifyFailure(error)).toMatchObject({
      retryAfterMs: 2000,
      scope: "credential",
      statusCode: 429,
    });
    expect(causeReads).toBe(1);
    expect(responseReads).toBe(1);
  });

  it("ignores echoed request fields inside Axios-style wrappers", () => {
    expect(
      defaultClassifyFailure({
        message: "job not found",
        response: {
          data: { prompt: "model not available invalid_api_key" },
        },
        statusCode: 404,
      })
    ).toEqual({ retryable: false, scope: "request", statusCode: 404 });
  });
});

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

  it("reads AI SDK responseHeaders and epoch reset values", () => {
    expect(
      retryAfterMsOf({ responseHeaders: { "x-ratelimit-reset": "5" } }, 1000)
    ).toBe(4000);
  });

  it("treats epoch reset thresholds inclusively", () => {
    const now = 20_000_000_000;
    expect(
      retryAfterMsOf(
        { responseHeaders: { "x-ratelimit-reset": "10000000000" } },
        now
      )
    ).toBe(0);
    expect(
      retryAfterMsOf(
        { responseHeaders: { "x-ratelimit-reset": "1000000000" } },
        2_000_000_000_000
      )
    ).toBe(0);
  });

  it("falls back to headers when responseHeaders lacks the requested field", () => {
    expect(
      retryAfterMsOf(
        {
          headers: { "retry-after": "3" },
          responseHeaders: { "content-type": "application/json" },
        },
        1000
      )
    ).toBe(3000);
  });

  it("falls back to parseable secondary header values", () => {
    expect(
      retryAfterMsOf(
        {
          headers: { "retry-after": "2" },
          responseHeaders: { "retry-after": "not-a-delay" },
        },
        1000
      )
    ).toBe(2000);
    expect(
      retryAfterMsOf(
        {
          headers: { "x-ratelimit-reset": "250ms" },
          responseHeaders: { "x-ratelimit-reset": "invalid" },
        },
        1000
      )
    ).toBe(250);
  });

  it("reads duration-style provider reset headers and uses the longest", () => {
    expect(
      retryAfterMsOf(
        {
          responseHeaders: {
            "x-ratelimit-reset": "10s",
            "x-ratelimit-reset-requests": "250ms",
            "x-ratelimit-reset-tokens": "5",
          },
        },
        2_000_000_000_000
      )
    ).toBe(10_000);
  });

  it("keeps valid combined reset members beside malformed values", () => {
    expect(
      retryAfterMsOf(
        {
          responseHeaders: {
            "x-ratelimit-reset": "bad, 5s, 250ms",
          },
        },
        1000
      )
    ).toBe(5000);
  });

  it("snapshots header containers once across all reset names", () => {
    let responseReads = 0;
    let headerReads = 0;
    const error = Object.defineProperties(
      {},
      {
        headers: {
          get() {
            headerReads += 1;
            if (headerReads > 1) {
              throw new Error("headers read twice");
            }
            return { "content-type": "application/json" };
          },
        },
        responseHeaders: {
          get() {
            responseReads += 1;
            if (responseReads > 1) {
              throw new Error("responseHeaders read twice");
            }
            return { "x-ratelimit-reset-tokens": "250ms" };
          },
        },
      }
    );

    expect(retryAfterMsOf(error, 1000)).toBe(250);
    expect(responseReads).toBe(1);
    expect(headerReads).toBe(1);
  });

  it("snapshots a Headers-like get operation once", () => {
    let getterReads = 0;
    let calls = 0;
    const headers = Object.defineProperty({}, "get", {
      get() {
        getterReads += 1;
        if (getterReads > 1) {
          throw new Error("get operation read twice");
        }
        return (name: string) => {
          calls += 1;
          return name === "x-ratelimit-reset-tokens" ? "125ms" : null;
        };
      },
    });

    expect(retryAfterMsOf({ responseHeaders: headers }, 1000)).toBe(125);
    expect(getterReads).toBe(1);
    expect(calls).toBe(6);
  });

  it("consumes async Headers-like results without reading thenables", async () => {
    const rejected = Promise.reject(new Error("async headers unsupported"));
    const asyncHeaders = { get: () => rejected };
    expect(retryAfterMsOf({ headers: asyncHeaders }, 1000)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));

    let reads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        reads += 1;
        throw new Error("then extension must not run");
      },
    });
    expect(
      retryAfterMsOf({ headers: { get: () => thenable } }, 1000)
    ).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("consumes async retry wrappers and plain header values", async () => {
    expect(
      retryAfterMsOf({
        cause: Promise.reject(new Error("async retry cause")),
        response: Promise.reject(new Error("async retry response")),
      })
    ).toBeUndefined();
    expect(
      retryAfterMsOf({
        headers: Promise.reject(new Error("async header source")),
        responseHeaders: {
          get: Promise.reject(new Error("async header get slot")),
        },
      })
    ).toBeUndefined();
    expect(
      retryAfterMsOf({
        headers: {
          "retry-after": Promise.reject(new Error("async retry header")),
        },
      })
    ).toBeUndefined();
    expect(
      retryAfterMsOf({
        headers: {
          "retry-after": [
            Promise.reject(new Error("async retry header item")),
            "2",
          ],
        },
      })
    ).toBe(2000);
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(
        () => Promise.reject(new Error("async retry clock")) as never
      );
    try {
      expect(retryAfterMsOf({ headers: { "retry-after": "2" } })).toBe(2000);
    } finally {
      now.mockRestore();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

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
