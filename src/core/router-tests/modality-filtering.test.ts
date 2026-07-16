import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { imagePart, NO_CANDIDATE_RE, okModel } from "./test-kit";

describe("createRouter — modality filtering", () => {
  it("skips a text-only entry and picks the image-capable one when an image is present", async () => {
    const textOnly = okModel("text-only");
    const imageCapable = okModel("image-capable");

    const route = createRouter({
      models: {
        chat: [
          { provider: () => textOnly, model: "t", supports: ["text"] },
          {
            provider: () => imageCapable,
            model: "i",
            supports: ["text", "image"],
          },
        ],
      },
    });

    const { text } = await generateText({
      model: route("chat"),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "describe" }, imagePart],
        },
      ],
    });

    expect(text).toBe("image-capable");
    expect(textOnly.doGenerateCalls).toHaveLength(0);
    expect(imageCapable.doGenerateCalls).toHaveLength(1);
  });

  it('throws a clear "no candidate ... modalities" error when no entry supports the modality', async () => {
    // Only text/image providers are configured, but the prompt carries a PDF.
    const textModel = okModel("text");
    const imageModel = okModel("image");

    const route = createRouter({
      models: {
        chat: [
          { provider: () => textModel, model: "t", supports: ["text"] },
          {
            provider: () => imageModel,
            model: "i",
            supports: ["text", "image"],
          },
        ],
      },
    });

    await expect(
      generateText({
        model: route("chat"),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "read this" },
              {
                type: "file",
                mediaType: "application/pdf",
                // 1x1 transparent png bytes are fine as opaque pdf payload here;
                // detection only reads mediaType, and no candidate matches so
                // the underlying models are never invoked.
                data: "data:application/pdf;base64,JVBERi0xLjQK",
              },
            ],
          },
        ],
      })
    ).rejects.toThrow(NO_CANDIDATE_RE);

    // No candidate matched, so nothing was ever called.
    expect(textModel.doGenerateCalls).toHaveLength(0);
    expect(imageModel.doGenerateCalls).toHaveLength(0);
  });

  it("routes unknown file media types only to generic-file or universal candidates", async () => {
    const textOnly = okModel("text-only");
    const fileModel = okModel("generic-file");
    const route = createRouter({
      models: {
        chat: [
          { model: textOnly, supports: ["text"] },
          { model: fileModel, supports: ["text", "file"] },
        ],
      },
    });

    const result = await generateText({
      model: route("chat"),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "file",
              mediaType: "application/octet-stream",
              data: "data:application/octet-stream;base64,AA==",
            },
          ],
        },
      ],
    });

    expect(result.text).toBe("generic-file");
    expect(textOnly.doGenerateCalls).toHaveLength(0);
  });
});
