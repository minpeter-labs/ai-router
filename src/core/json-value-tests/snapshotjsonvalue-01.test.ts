import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { countJsonContainersUpTo, snapshotJsonValue } from "../json-value";

describe("snapshotJsonValue", () => {
  it("copies dense JSON values and special keys safely", () => {
    const source = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(source, "__proto__", {
      enumerable: true,
      value: { safe: true },
    });
    source.items = [1, "two", false, null];

    const snapshot = snapshotJsonValue(source);

    expect(snapshot.valid).toBe(true);
    const value = snapshot.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Reflect.get(value, "__proto__")).toEqual({ safe: true });
    expect(value.items).toEqual([1, "two", false, null]);
  });

  it("rejects cycles, sparse arrays, invalid primitives, and hostile getters", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const hostile = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });

    for (const value of [
      circular,
      new Array(1),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      1n,
      hostile,
    ]) {
      expect(snapshotJsonValue(value).valid).toBe(false);
    }
  });

  it("consumes nested rejected Promises without inspecting arbitrary thenables", async () => {
    let thenReads = 0;
    const arbitraryThenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        return () => undefined;
      },
    });
    const value = {
      first: Promise.reject(new Error("nested JSON rejection")),
      second: [Promise.reject(new Error("nested array rejection"))],
      third: arbitraryThenable,
    };

    expect(snapshotJsonValue(value).valid).toBe(false);
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes data Promise siblings before ordinary object and array getters fail", async () => {
    const object = Object.defineProperties(
      {},
      {
        first: {
          enumerable: true,
          get() {
            throw new Error("object getter failed");
          },
        },
        second: {
          enumerable: true,
          value: Promise.reject(new Error("object Promise sibling")),
        },
      }
    );
    const array = Object.defineProperties([], {
      0: {
        enumerable: true,
        get() {
          throw new Error("array getter failed");
        },
      },
      1: {
        enumerable: true,
        value: Promise.reject(new Error("array Promise sibling")),
      },
      length: { value: 2 },
    });

    expect(snapshotJsonValue(object).valid).toBe(false);
    expect(snapshotJsonValue(array).valid).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects oversized object keys before reading any values", () => {
    let reads = 0;
    const target = Object.fromEntries(
      Array.from({ length: 1025 }, (_, index) => [`key-${index}`, index])
    );
    const value = new Proxy(target, {
      get(object, key, receiver) {
        reads += 1;
        return Reflect.get(object, key, receiver);
      },
    });

    expect(snapshotJsonValue(value).valid).toBe(false);
    expect(reads).toBe(0);
  });

  it("allows repeated non-cyclic references by copying each occurrence", () => {
    const shared = { value: "ok" };
    const snapshot = snapshotJsonValue({ first: shared, second: shared });

    expect(snapshot).toEqual({
      characters: 25,
      containers: 3,
      valid: true,
      value: { first: { value: "ok" }, second: { value: "ok" } },
    });
  });

  it("accepts cross-realm plain objects but rejects non-JSON containers", () => {
    const crossRealm = runInNewContext("({ nested: { value: 1 } })") as unknown;

    expect(snapshotJsonValue(crossRealm)).toEqual({
      characters: 11,
      containers: 2,
      valid: true,
      value: { nested: { value: 1 } },
    });

    class CustomValue {
      value = 1;
    }
    for (const value of [
      new Date(0),
      new Map([["key", "value"]]),
      new Set([1]),
      new Uint8Array([1]),
      new CustomValue(),
    ]) {
      expect(snapshotJsonValue(value).valid).toBe(false);
    }
  });

  it("reads Proxy-backed array lengths and indexes exactly once", () => {
    const reads = { index: 0, length: 0 };
    const source = new Proxy([{ stable: true }], {
      get(target, property, receiver) {
        if (property === "0") {
          reads.index += 1;
        } else if (property === "length") {
          reads.length += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(snapshotJsonValue(source)).toEqual({
      characters: 6,
      containers: 2,
      valid: true,
      value: [{ stable: true }],
    });
    expect(reads).toEqual({ index: 1, length: 1 });
  });

  it("counts JSON containers only up to the requested cap", () => {
    const value = { items: [{}, { nested: [] }, {}] };

    expect(countJsonContainersUpTo(value, 10)).toBe(6);
    expect(countJsonContainersUpTo(value, 3)).toBe(4);
    expect(countJsonContainersUpTo("text", 3)).toBe(0);
  });

  it("counts arrays by index without invoking iterators and fails closed", () => {
    let iteratorReads = 0;
    const nested = Object.defineProperty([{}], Symbol.iterator, {
      get() {
        iteratorReads += 1;
        throw new Error("iterator must not run");
      },
    });

    expect(countJsonContainersUpTo(nested, 3)).toBe(2);
    expect(iteratorReads).toBe(0);

    const hostile = new Proxy(
      { nested: {} },
      {
        ownKeys() {
          throw new Error("keys unavailable");
        },
      }
    );
    expect(countJsonContainersUpTo(hostile, 3)).toBe(4);
    expect(countJsonContainersUpTo([{}], Number.NaN)).toBe(1);
  });
});
