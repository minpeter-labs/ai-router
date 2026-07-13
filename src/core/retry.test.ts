import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  defaultShouldRetryThisError,
  normalizeError,
  safeShouldRetry,
  surfaceFailure,
} from "./retry";

describe("safeShouldRetry", () => {
  it("consumes rejected native Promise results without retrying", async () => {
    expect(
      safeShouldRetry(
        (() => Promise.reject(new Error("async retry rejected"))) as never,
        new Error("provider failed")
      )
    ).toBe(false);
    await Promise.resolve();
  });

  it("does not read arbitrary then extension getters", () => {
    let reads = 0;
    const result = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        reads += 1;
        throw new Error("then getter must not run");
      },
    });

    expect(
      safeShouldRetry((() => result) as never, new Error("provider failed"))
    ).toBe(false);
    expect(reads).toBe(0);
  });
});

describe("defaultShouldRetryThisError", () => {
  it("retries provider-scoped client failures", () => {
    for (const statusCode of [
      400, 401, 402, 403, 408, 409, 412, 413, 421, 422, 425, 429, 498,
    ]) {
      expect(defaultShouldRetryThisError({ statusCode })).toBe(true);
    }
  });

  it("retries any 5xx status code", () => {
    for (const statusCode of [500, 502, 503, 504, 599]) {
      expect(defaultShouldRetryThisError({ statusCode })).toBe(true);
    }
  });

  it("does not read error details for an unambiguous non-404 status", () => {
    let reads = 0;
    const error = Object.defineProperty({ statusCode: 503 }, "message", {
      get() {
        reads += 1;
        throw new Error("message must not be read");
      },
    });

    expect(defaultShouldRetryThisError(error)).toBe(true);
    expect(reads).toBe(0);
  });

  it("does not read a wrapped cause after an authoritative retry status", () => {
    let reads = 0;
    const error = Object.defineProperty({ statusCode: 503 }, "cause", {
      get() {
        reads += 1;
        throw new Error("cause must not be read");
      },
    });

    expect(defaultShouldRetryThisError(error)).toBe(true);
    expect(reads).toBe(0);
  });

  it("consumes an inactive Promise cause behind an authoritative status", async () => {
    const error = {
      cause: Promise.reject(new Error("inactive async cause")),
      statusCode: 503,
    };

    expect(defaultShouldRetryThisError(error)).toBe(true);
    expect(normalizeError(error)).toMatchObject({ statusCode: 503 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes a Promise-valued abort name on a wrapped Error cause", async () => {
    const cause = new Error("provider failed");
    Object.defineProperty(cause, "name", {
      value: Promise.reject(new Error("async abort name")),
    });

    expect(defaultShouldRetryThisError({ cause })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("uses a valid status alias when statusCode is malformed", () => {
    const error = { status: 429, statusCode: "ERR_RATE_LIMIT" };
    expect(defaultShouldRetryThisError(error)).toBe(true);
    expect(normalizeError(error)).toMatchObject({ statusCode: 429 });
  });

  it("does not read lower-precedence aliases after a valid status", () => {
    let reads = 0;
    const error = Object.defineProperty({ statusCode: 503 }, "status", {
      get() {
        reads += 1;
        throw new Error("lower status alias must not be read");
      },
    });

    expect(defaultShouldRetryThisError(error)).toBe(true);
    expect(reads).toBe(0);
  });

  it("does not fan out when every explicit status accessor is unreadable", () => {
    const error = Object.defineProperty({}, "statusCode", {
      get() {
        throw new Error("status unavailable");
      },
    });
    expect(defaultShouldRetryThisError(error)).toBe(false);

    Object.defineProperty(error, "status", { value: 429 });
    expect(defaultShouldRetryThisError(error)).toBe(true);
    expect(
      defaultShouldRetryThisError({
        cause: { statusCode: 503 },
        get statusCode() {
          throw new Error("top status unavailable");
        },
      })
    ).toBe(true);
  });

  it("does not fan out when status-bearing wrappers are unreadable", () => {
    const unreadableResponse = Object.defineProperty({}, "response", {
      get() {
        throw new Error("response unavailable");
      },
    });
    expect(defaultShouldRetryThisError(unreadableResponse)).toBe(false);

    Object.defineProperty(unreadableResponse, "statusCode", { value: 503 });
    expect(defaultShouldRetryThisError(unreadableResponse)).toBe(true);

    const unreadableCause = Object.defineProperty({}, "cause", {
      get() {
        throw new Error("cause unavailable");
      },
    });
    expect(defaultShouldRetryThisError(unreadableCause)).toBe(false);
  });

  it("does not fan out when the only structured code is unreadable", () => {
    const error = Object.defineProperty({}, "code", {
      get() {
        throw new Error("code unavailable");
      },
    });
    expect(defaultShouldRetryThisError(error)).toBe(false);

    Object.defineProperty(error, "statusCode", { value: 503 });
    expect(defaultShouldRetryThisError(error)).toBe(true);

    const recoverable = Object.defineProperty(
      { responseBody: { error: { code: "insufficient_quota" } } },
      "code",
      {
        get() {
          throw new Error("top code unavailable");
        },
      }
    );
    expect(defaultShouldRetryThisError(recoverable)).toBe(true);
  });

  it("reads Axios-style nested response statuses", () => {
    expect(defaultShouldRetryThisError({ response: { status: 429 } })).toBe(
      true
    );
    expect(defaultShouldRetryThisError({ response: { status: 404 } })).toBe(
      false
    );
    expect(normalizeError({ response: { status: 429 } })).toMatchObject({
      statusCode: 429,
    });
  });

  it("uses a wrapped cause status only when the top level has none", () => {
    expect(defaultShouldRetryThisError({ cause: { statusCode: 429 } })).toBe(
      true
    );
    expect(
      defaultShouldRetryThisError({
        cause: {
          responseBody: { error: { code: "insufficient_quota" } },
          statusCode: 429,
        },
        message: "job not found",
        statusCode: 404,
      })
    ).toBe(false);
  });

  it("consumes rejected Promise causes without retrying unknown failures", async () => {
    expect(
      defaultShouldRetryThisError({
        cause: Promise.reject(new Error("async provider cause")),
      })
    ).toBe(false);
    expect(
      normalizeError({
        cause: Promise.reject(new Error("async normalization cause")),
      }).statusCode
    ).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected Promise response containers as malformed evidence", async () => {
    expect(
      defaultShouldRetryThisError({
        response: Promise.reject(new Error("async top response")),
      })
    ).toBe(false);
    expect(
      defaultShouldRetryThisError({
        cause: {
          response: Promise.reject(new Error("async cause response")),
        },
      })
    ).toBe(false);
    expect(
      normalizeError({
        response: Promise.reject(new Error("async normalized response")),
      }).statusCode
    ).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

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

  it("reads an abort error name once", () => {
    let reads = 0;
    const error = Object.defineProperty(new Error("response stopped"), "name", {
      get() {
        reads += 1;
        if (reads > 1) {
          throw new Error("name read twice");
        }
        return "ResponseAborted";
      },
    });

    expect(defaultShouldRetryThisError(error)).toBe(false);
    expect(reads).toBe(1);
  });

  it("recognizes genuine cross-realm abort errors without trusting lookalikes", () => {
    const crossRealm = runInNewContext(
      'Object.assign(new Error("stopped"), { name: "ResponseAborted" })'
    );

    expect(defaultShouldRetryThisError(crossRealm)).toBe(false);
    expect(
      defaultShouldRetryThisError({
        message: "not a genuine error",
        name: "ResponseAborted",
      })
    ).toBe(true);
  });

  it("recognizes DOMException internal slots across prototype boundaries", () => {
    const abort = new DOMException("stopped", "AbortError");
    Object.defineProperty(abort, "name", { value: abort.name });
    Object.setPrototypeOf(abort, null);

    expect(abort instanceof DOMException).toBe(false);
    expect(defaultShouldRetryThisError(abort)).toBe(false);
    expect(
      defaultShouldRetryThisError({
        message: "not a genuine DOMException",
        name: "AbortError",
      })
    ).toBe(true);
  });
});

describe("normalizeError", () => {
  it("reads statusCode from statusCode and status", () => {
    expect(normalizeError({ statusCode: 429 }).statusCode).toBe(429);
    expect(normalizeError({ status: 503 }).statusCode).toBe(503);
  });

  it("normalizes a one-level wrapped cause with top-level precedence", () => {
    expect(
      normalizeError({
        cause: { message: "RATE LIMITED", statusCode: 429 },
      })
    ).toEqual({ message: "rate limited", statusCode: 429 });
    expect(
      normalizeError({
        cause: { message: "RATE LIMITED", statusCode: 429 },
        message: "JOB NOT FOUND",
        statusCode: 404,
      })
    ).toEqual({ message: "job not found", statusCode: 404 });

    let causeReads = 0;
    const complete = Object.defineProperty(
      { message: "JOB NOT FOUND", statusCode: 404 },
      "cause",
      {
        get() {
          causeReads += 1;
          throw new Error("cause must not be read");
        },
      }
    );
    expect(normalizeError(complete)).toEqual({
      message: "job not found",
      statusCode: 404,
    });
    expect(causeReads).toBe(0);
  });

  it("ignores a non-numeric code (e.g. ECONNRESET) and lowercases the message", () => {
    const out = normalizeError({
      code: "ECONNRESET",
      message: "Socket HANG UP",
    });
    expect(out.statusCode).toBeUndefined();
    expect(out.message).toBe("socket hang up");
  });

  it("JSON-stringifies an object error that lacks a message string", () => {
    const out = normalizeError({ error: "Capacity" });
    expect(out.message).toContain("capacity");
  });

  it("handles null/undefined and primitive errors", () => {
    expect(normalizeError(null).message).toBe("");
    expect(normalizeError("Boom").message).toBe("boom");
  });
});

describe("surfaceFailure", () => {
  it("returns the single error verbatim (identity preserved)", () => {
    const e = new Error("only failure");
    expect(surfaceFailure([e], "chat")).toBe(e);
  });

  it("aggregates multiple errors with the last message embedded", () => {
    const e1 = new Error("first failure");
    const e2 = new Error("second failure");
    const e3 = new Error("last failure");
    const surfaced = surfaceFailure([e1, e2, e3], "chat") as AggregateError;

    expect(surfaced).toBeInstanceOf(AggregateError);
    expect(surfaced.errors).toHaveLength(3);
    expect(surfaced.errors).toEqual([e1, e2, e3]);
    expect(surfaced.cause).toBe(e3);
    expect(surfaced.message).toContain("last failure");
    expect(surfaced.message).toContain("chat");
  });

  it("snapshots the aggregate error list while preserving element identity", () => {
    const first = new Error("first");
    const last = new Error("last");
    const failures = [first, last];
    const surfaced = surfaceFailure(failures, "chat") as AggregateError;

    failures.length = 0;
    failures.push(new Error("later mutation"));

    expect(surfaced.errors).toEqual([first, last]);
    expect(surfaced.cause).toBe(last);
  });

  it("does not invoke source array methods or iterators while aggregating", () => {
    let reads = 0;
    const first = new Error("first");
    const last = new Error("last");
    const failures = [first, last];
    Object.defineProperties(failures, {
      at: {
        get() {
          reads += 1;
          throw new Error("at extension must not run");
        },
      },
      [Symbol.iterator]: {
        get() {
          reads += 1;
          throw new Error("iterator extension must not run");
        },
      },
    });

    const surfaced = surfaceFailure(failures, "chat") as AggregateError;
    expect(surfaced.errors).toEqual([first, last]);
    expect(surfaced.cause).toBe(last);
    expect(reads).toBe(0);
  });

  it("aggregates a hostile final error without reading unsafe getters", () => {
    let reads = 0;
    const hostile = Object.defineProperties(new Error("hidden"), {
      message: {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error("getter failed");
        },
      },
      statusCode: { enumerable: true, value: 503 },
    });

    const surfaced = surfaceFailure(
      [new Error("first"), hostile],
      "chat"
    ) as AggregateError;
    expect(surfaced).toBeInstanceOf(AggregateError);
    expect(surfaced.errors).toEqual([expect.any(Error), hostile]);
    expect(surfaced.message).toContain("503");
    expect(reads).toBe(0);
  });

  it("uses a callable final error message without losing cause identity", () => {
    const callable = Object.assign(() => undefined, {
      message: "callable final failure",
    });
    const surfaced = surfaceFailure(
      [new Error("first"), callable],
      "chat"
    ) as AggregateError;

    expect(surfaced.cause).toBe(callable);
    expect(surfaced.message).toContain("callable final failure");
  });
});
