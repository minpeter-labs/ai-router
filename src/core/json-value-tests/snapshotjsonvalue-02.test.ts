import { describe, expect, it } from "vitest";
import { countJsonContainersUpTo, snapshotJsonValue } from "../json-value";

describe("snapshotJsonValue", () => {
  it("consumes Promise siblings before container-count getters fail", async () => {
    const object = Object.defineProperties(
      {},
      {
        first: {
          enumerable: true,
          get() {
            throw new Error("count getter failed");
          },
        },
        second: {
          enumerable: true,
          value: Promise.reject(new Error("count Promise sibling")),
        },
      }
    );
    const array = Object.defineProperties([], {
      0: {
        get() {
          throw new Error("count array getter failed");
        },
      },
      1: {
        value: Promise.reject(new Error("count array Promise sibling")),
      },
      length: { value: 2 },
    });

    expect(countJsonContainersUpTo(object, 10)).toBe(11);
    expect(countJsonContainersUpTo(array, 10)).toBe(11);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("enforces explicit container budgets", () => {
    expect(snapshotJsonValue({}, 0).valid).toBe(false);
    expect(snapshotJsonValue([], Number.NaN).valid).toBe(false);
    expect(snapshotJsonValue("primitive", 0)).toEqual({
      characters: 9,
      containers: 0,
      valid: true,
      value: "primitive",
    });
    expect(snapshotJsonValue("large", 0, 4).valid).toBe(false);
    expect(snapshotJsonValue({ oversized: true }, 1, 4).valid).toBe(false);
  });
});
