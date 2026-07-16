import { describe, expect, it } from "vitest";
import { defaultShouldRetryThisError, normalizeError } from "../retry";

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
});
