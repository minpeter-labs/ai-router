import { describe, expect, it } from "vitest";
import { safeShouldRetry } from "../retry";

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
