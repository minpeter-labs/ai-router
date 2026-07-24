import { describe, expect, it } from "vitest";
import { defaultClassifyFailure } from "../failure";
import { retryAfterMsOf } from "../failure-retry-after";

describe("defaultClassifyFailure", () => {
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
