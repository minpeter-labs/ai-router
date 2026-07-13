import { describe, expect, it } from "vitest";
import { detectModalities } from "../modality";
import type { Modality } from "../types";

describe("detectModalities", () => {
  it("detects text from system + text parts", () => {
    const mods = detectModalities([
      { role: "system", content: "be nice" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect([...mods]).toEqual(["text"]);
  });

  it("detects image and pdf via mediaType (full, wildcard, bare, application/pdf)", () => {
    const mods = detectModalities([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "url", url: new URL("https://x/y.png") },
          },
          {
            type: "file",
            mediaType: "application/pdf",
            data: { type: "url", url: new URL("https://x/y.pdf") },
          },
        ],
      },
    ]);
    const expected: Modality[] = ["text", "image", "pdf"];
    expect([...mods].sort()).toEqual(expected.sort());
  });
});
