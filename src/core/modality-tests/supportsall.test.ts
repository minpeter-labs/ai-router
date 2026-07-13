import { describe, expect, it } from "vitest";
import { supportsAll } from "../modality";

describe("supportsAll", () => {
  it("returns true when required is a subset of supports", () => {
    expect(
      supportsAll(["text", "image", "pdf"], new Set(["text", "image"]))
    ).toBe(true);
  });

  it("returns true when required equals supports", () => {
    expect(supportsAll(["text", "image"], new Set(["text", "image"]))).toBe(
      true
    );
  });

  it("returns false when a required modality is missing from supports", () => {
    expect(supportsAll(["text"], new Set(["text", "image"]))).toBe(false);
  });

  it("returns true for an empty required set", () => {
    expect(supportsAll(["text"], new Set())).toBe(true);
  });

  it("returns true for an empty required set even when supports is empty", () => {
    expect(supportsAll([], new Set())).toBe(true);
  });

  it("returns false when supports is empty but a modality is required", () => {
    expect(supportsAll([], new Set(["text"]))).toBe(false);
  });
});
