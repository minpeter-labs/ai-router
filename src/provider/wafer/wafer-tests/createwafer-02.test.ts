import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { captureFetch } from "../../test-utils";
import { createWafer } from "../wafer";

describe("createWafer", () => {
  it("keeps `Wafer-ZDR: required` when call headers try to override it", async () => {
    const { fetch, captured } = captureFetch();
    const wafer = createWafer({ apiKey: "k", fetch, zdr: true });

    await generateText({
      model: wafer("m"),
      prompt: "hi",
      headers: { "Wafer-ZDR": "optional" },
    });

    expect(captured.headers.get("wafer-zdr")).toBe("required");
  });

  it("preserves caller-supplied headers alongside the ZDR header", async () => {
    const { fetch, captured } = captureFetch();
    const wafer = createWafer({
      apiKey: "k",
      fetch,
      zdr: true,
      headers: { "x-custom": "1" },
    });

    await generateText({ model: wafer("m"), prompt: "hi" });

    expect(captured.headers.get("x-custom")).toBe("1");
    expect(captured.headers.get("wafer-zdr")).toBe("required");
  });

  it("surfaces MiniMax-M3 inline <think> reasoning as a reasoning part", async () => {
    // MiniMax-M3 returns reasoning inline in `content` rather than in a separate
    // `reasoning_content` field; the extractReasoningMiddleware should split it out.
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        Response.json({
          id: "1",
          object: "chat.completion",
          created: 0,
          model: "MiniMax-M3",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "<think>because</think>Hello",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    const wafer = createWafer({ apiKey: "k", fetch });

    const result = await generateText({
      model: wafer("MiniMax-M3"),
      prompt: "hi",
    });

    expect(result.finalStep.reasoningText).toContain("because");
    expect(result.text).toContain("Hello");
    expect(result.text).not.toContain("<think>");
  });
});
