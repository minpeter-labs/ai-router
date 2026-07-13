import { describe, expect, it } from "vitest";
import { defaultShouldRetryThisError, normalizeError } from "../retry";

describe("defaultShouldRetryThisError", () => {
  it("consumes Promise-valued status and code evidence without reading thenables", async () => {
    expect(
      defaultShouldRetryThisError({
        code: Promise.reject(new Error("async error code")),
        statusCode: Promise.reject(new Error("async error status")),
      })
    ).toBe(false);

    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    expect(defaultShouldRetryThisError({ code: thenable })).toBe(true);
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not fan out on a fractional pseudo-status value", () => {
    expect(defaultShouldRetryThisError({ statusCode: 404.5 })).toBe(false);
    expect(normalizeError({ statusCode: 404.5 }).statusCode).toBeUndefined();
  });

  it("rejects out-of-range pseudo-status values but uses valid evidence", () => {
    for (const statusCode of [-1, 0, 99, 600, 999]) {
      expect(defaultShouldRetryThisError({ statusCode })).toBe(false);
      expect(normalizeError({ statusCode }).statusCode).toBeUndefined();
    }
    expect(defaultShouldRetryThisError({ status: 429, statusCode: 999 })).toBe(
      true
    );
    expect(normalizeError({ status: 429, statusCode: 999 }).statusCode).toBe(
      429
    );
    expect(
      defaultShouldRetryThisError({
        cause: { statusCode: 429 },
        statusCode: 999,
      })
    ).toBe(true);
    expect(
      defaultShouldRetryThisError({
        code: "insufficient_quota",
        statusCode: 999,
      })
    ).toBe(true);
  });

  it("STOPS on a 4xx client error that is not provider-scoped", () => {
    for (const statusCode of [404, 410]) {
      expect(defaultShouldRetryThisError({ statusCode })).toBe(false);
    }
  });

  it("reads status and details from callable provider errors", () => {
    const callable = Object.assign(() => undefined, {
      message: "job not found",
      statusCode: 404,
    });

    expect(defaultShouldRetryThisError(callable)).toBe(false);
    expect(normalizeError(callable)).toMatchObject({
      message: "job not found",
      statusCode: 404,
    });
  });

  it("retries a 404 when that provider does not serve the model", () => {
    expect(
      defaultShouldRetryThisError({
        statusCode: 404,
        responseBody: { error: { message: "model is not available" } },
      })
    ).toBe(true);
    expect(
      defaultShouldRetryThisError({
        statusCode: 404,
        message: "unknown unrelated resource",
      })
    ).toBe(false);
  });

  it("retries provider 404s with no model-serving endpoints", () => {
    for (const message of [
      "No endpoints found for model k-exaone",
      "No available endpoint was found that supports the requested parameters",
    ]) {
      expect(defaultShouldRetryThisError({ message, statusCode: 404 })).toBe(
        true
      );
    }
  });

  it("retries provider-specific unavailability responses", () => {
    for (const [statusCode, message] of [
      [404, "The requested provider 'deepinfra' is not available."],
      [
        404,
        "Requested model is not supported by any provider you have enabled",
      ],
      [404, "Unable to access model; see supported models"],
    ] as const) {
      expect(defaultShouldRetryThisError({ message, statusCode })).toBe(true);
    }
  });

  it("retries common 404 credit exhaustion phrasings", () => {
    for (const message of [
      "not enough credits",
      "credit balance is too low",
      "account has run out of funds",
      "credits depleted",
    ]) {
      expect(defaultShouldRetryThisError({ message, statusCode: 404 })).toBe(
        true
      );
    }
  });

  it("retries explicit structured credential exhaustion codes", () => {
    for (const code of [
      "rate_limit_error",
      "insufficient_quota",
      "quota_exceeded",
      "NO_MORE_CREDITS",
    ]) {
      expect(
        defaultShouldRetryThisError({
          responseBody: { error: { code } },
          statusCode: 404,
        })
      ).toBe(true);
    }
  });

  it("retries explicit hard-auth codes despite a non-standard status", () => {
    expect(
      defaultShouldRetryThisError({
        responseBody: { error: { code: "invalid_api_key" } },
        statusCode: 404,
      })
    ).toBe(true);
  });

  it("retries explicit model-unavailable codes despite a non-standard status", () => {
    expect(
      defaultShouldRetryThisError({
        code: "model_not_available",
        statusCode: 410,
      })
    ).toBe(true);
  });

  it("does not treat marker-shaped object keys as structured codes", () => {
    expect(
      defaultShouldRetryThisError({
        responseBody: { invalid_api_key: false },
        statusCode: 404,
      })
    ).toBe(false);
    expect(
      defaultShouldRetryThisError({
        responseBody: { model_not_available: false },
        statusCode: 404,
      })
    ).toBe(false);
  });

  it("retries any error without a recognizable status (preserves legacy retry-on-any-throw)", () => {
    // No statusCode -> treated as transient/unknown -> retried, regardless of message.
    expect(defaultShouldRetryThisError(new Error("boom"))).toBe(true);
    expect(defaultShouldRetryThisError(new Error("first failure"))).toBe(true);
    expect(defaultShouldRetryThisError(new Error("overloaded"))).toBe(true);
    expect(defaultShouldRetryThisError("overloaded 503")).toBe(true);
    expect(defaultShouldRetryThisError({ error: "capacity exceeded" })).toBe(
      true
    );
    expect(defaultShouldRetryThisError(null)).toBe(true);
  });

  it("still retries a transient status even when the message looks terminal", () => {
    expect(
      defaultShouldRetryThisError({ statusCode: 503, message: "bad request" })
    ).toBe(true);
  });

  it("classifies hostile provider error proxies without throwing", () => {
    const hostile = new Proxy(
      { message: "provider overloaded", statusCode: 503 },
      {
        getPrototypeOf() {
          throw new Error("prototype unavailable");
        },
      }
    );

    expect(() => defaultShouldRetryThisError(hostile)).not.toThrow();
    expect(defaultShouldRetryThisError(hostile)).toBe(true);
  });

  it("does NOT retry a caller abort / timeout (would swallow the abort)", () => {
    expect(
      defaultShouldRetryThisError(
        Object.assign(new Error("aborted"), { name: "AbortError" })
      )
    ).toBe(false);
    expect(
      defaultShouldRetryThisError(new DOMException("timed out", "TimeoutError"))
    ).toBe(false);
  });
});
