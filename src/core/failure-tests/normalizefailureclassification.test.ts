import { describe, expect, it } from "vitest";
import {
  isTerminalRequestFailure,
  normalizeFailureClassification,
} from "../failure";

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
