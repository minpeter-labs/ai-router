import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { defaultShouldRetryThisError } from "../retry";

describe("defaultShouldRetryThisError", () => {
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
