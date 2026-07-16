import { describe, expect, it } from "vitest";
import { filePart, sorted, sortedModalities } from "./test-kit";

describe("detectModalities", () => {
  it("maps a system message to text", () => {
    expect(sortedModalities([{ role: "system", content: "be nice" }])).toEqual([
      "text",
    ]);
  });

  it("maps a text part to text", () => {
    expect(
      sortedModalities([
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ])
    ).toEqual(["text"]);
  });

  it("maps a reasoning part to text", () => {
    expect(
      sortedModalities([
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "thinking..." }],
        },
      ])
    ).toEqual(["text"]);
  });

  it("maps image via full media type (image/png) to image", () => {
    expect(
      sortedModalities([{ role: "user", content: [filePart("image/png")] }])
    ).toEqual(["image"]);
  });

  it("maps image via wildcard media type (image/*) to image", () => {
    expect(
      sortedModalities([{ role: "user", content: [filePart("image/*")] }])
    ).toEqual(["image"]);
  });

  it("maps image via bare top-level media type (image) to image", () => {
    expect(
      sortedModalities([{ role: "user", content: [filePart("image")] }])
    ).toEqual(["image"]);
  });

  it("maps video (video/mp4) to video", () => {
    expect(
      sortedModalities([{ role: "user", content: [filePart("video/mp4")] }])
    ).toEqual(["video"]);
  });

  it("maps audio (audio/mpeg) to audio", () => {
    expect(
      sortedModalities([{ role: "user", content: [filePart("audio/mpeg")] }])
    ).toEqual(["audio"]);
  });

  it("maps pdf via application/pdf to pdf", () => {
    expect(
      sortedModalities([
        { role: "user", content: [filePart("application/pdf")] },
      ])
    ).toEqual(["pdf"]);
  });

  it("maps pdf via application/x-pdf to pdf", () => {
    expect(
      sortedModalities([
        { role: "user", content: [filePart("application/x-pdf")] },
      ])
    ).toEqual(["pdf"]);
  });

  it("maps unknown media types to generic file support", () => {
    expect(
      sortedModalities([
        { role: "user", content: [filePart("application/octet-stream")] },
      ])
    ).toEqual(["file"]);
  });

  it("detects assistant reasoning files", () => {
    expect(
      sortedModalities([
        {
          role: "assistant",
          content: [
            {
              type: "reasoning-file",
              mediaType: "image/png",
              data: {
                type: "url",
                url: new URL("https://x/reasoning.png"),
              },
            },
          ],
        },
      ])
    ).toEqual(["image"]);
  });

  it("detects files nested in tool-result content", () => {
    expect(
      sortedModalities([
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "render",
              output: {
                type: "content",
                value: [
                  {
                    type: "file",
                    mediaType: "application/pdf",
                    data: {
                      type: "url",
                      url: new URL("https://x/result.pdf"),
                    },
                  },
                ],
              },
            },
          ],
        },
      ])
    ).toEqual(["pdf"]);
  });

  it("keeps text media files distinct from inline text parts", () => {
    expect(
      sortedModalities([{ role: "user", content: [filePart("text/csv")] }])
    ).toEqual(["file"]);
  });

  it("collects the set of all modalities across mixed parts (text + image + pdf)", () => {
    expect(
      sortedModalities([
        {
          role: "user",
          content: [
            { type: "text", text: "look at these" },
            filePart("image/png"),
            filePart("application/pdf"),
          ],
        },
      ])
    ).toEqual(sorted(["text", "image", "pdf"]));
  });

  it("returns an empty set for an empty prompt", () => {
    expect(sortedModalities([])).toEqual([]);
  });

  it("ignores tool-call and tool-result parts", () => {
    expect(
      sortedModalities([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "t1",
              toolName: "lookup",
              input: { q: "x" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "t1",
              toolName: "lookup",
              output: { type: "text", value: "result" },
            },
          ],
        },
      ])
    ).toEqual([]);
  });

  it("detects only real modalities when tool parts are mixed with content", () => {
    expect(
      sortedModalities([
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling tool" },
            {
              type: "tool-call",
              toolCallId: "t1",
              toolName: "lookup",
              input: { q: "x" },
            },
          ],
        },
        {
          role: "user",
          content: [filePart("audio/mpeg")],
        },
      ])
    ).toEqual(sorted(["text", "audio"]));
  });
});
