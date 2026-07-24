import { describe, expect, it } from "vitest";
import { defaultClassifyFailure } from "../failure";

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
});
