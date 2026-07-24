import { describe, expect, it, vi } from "vitest";
import { retryAfterMsOf } from "../failure-retry-after";

describe("retryAfterMsOf", () => {
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
});
