import { describe, expect, it } from "vitest";
import { surfaceFailure } from "../retry";

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
