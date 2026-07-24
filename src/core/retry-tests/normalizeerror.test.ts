import { describe, expect, it } from "vitest";
import { normalizeError } from "../retry";

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
