import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  isBoundedIdentifier,
  isDottedIdentifier,
  isPlainObjectValue,
  isUint8ArrayValue,
  isUrlValue,
} from "./runtime-types";

describe("cross-realm runtime types", () => {
  it("accepts cross-realm plain records but rejects runtime containers", () => {
    expect(isPlainObjectValue(runInNewContext("({ value: 1 })"))).toBe(true);
    expect(isPlainObjectValue(Object.create(null))).toBe(true);
    expect(isPlainObjectValue(new Date())).toBe(false);
    expect(isPlainObjectValue([])).toBe(false);
    expect(isPlainObjectValue(new (class Config {})())).toBe(false);
  });

  it("recognizes a Uint8Array from another realm", () => {
    const value = runInNewContext("new Uint8Array([1, 2, 3])") as unknown;

    expect(value instanceof Uint8Array).toBe(false);
    expect(isUint8ArrayValue(value)).toBe(true);
    expect(isUint8ArrayValue(new Uint8ClampedArray(1))).toBe(false);
    expect(isUint8ArrayValue({ [Symbol.toStringTag]: "Uint8Array" })).toBe(
      false
    );
  });

  it("does not invoke Uint8Array toStringTag extensions", () => {
    let reads = 0;
    const value = Object.defineProperty(
      new Uint8Array([1, 2, 3]),
      Symbol.toStringTag,
      {
        get() {
          reads += 1;
          throw new Error("toStringTag extension must not run");
        },
      }
    );

    expect(isUint8ArrayValue(value)).toBe(true);
    expect(reads).toBe(0);
  });

  it("uses the URL brand operation instead of accepting lookalikes", () => {
    expect(isUrlValue(new URL("https://example.com/file"))).toBe(true);
    expect(isUrlValue({ href: "https://example.com/file" })).toBe(false);
    expect(isUrlValue(Object.create(URL.prototype))).toBe(false);
  });

  it("validates namespaced dotted identifiers", () => {
    expect(isDottedIdentifier("provider.kind")).toBe(true);
    expect(isDottedIdentifier("provider.nested.kind")).toBe(true);
    expect(isDottedIdentifier("provider")).toBe(false);
    expect(isDottedIdentifier(".kind")).toBe(false);
    expect(isDottedIdentifier("provider.")).toBe(false);
  });

  it("rejects empty and oversized tracked identifiers", () => {
    expect(isBoundedIdentifier("id")).toBe(true);
    expect(isBoundedIdentifier("")).toBe(false);
    expect(isBoundedIdentifier("x".repeat(4096))).toBe(true);
    expect(isBoundedIdentifier("x".repeat(4097))).toBe(false);
  });
});
