import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { imagePart, okModel } from "./test-kit";

describe("createRouter — supports optional (P2-A)", () => {
  it("routes a modality to an entry with omitted supports when siblings reject it", async () => {
    const textOnly = okModel("text-only");
    const universal = okModel("universal");

    const route = createRouter({
      models: {
        chat: [
          { provider: () => textOnly, model: "t", supports: ["text"] },
          { provider: () => universal, model: "u" }, // no supports => matches any modality
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

    expect(text).toBe("universal");
    expect(textOnly.doGenerateCalls).toHaveLength(0);
    expect(universal.doGenerateCalls).toHaveLength(1);
  });
});
