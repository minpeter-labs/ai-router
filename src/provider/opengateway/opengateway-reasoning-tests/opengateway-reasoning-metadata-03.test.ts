import type { MetadataExtractor } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createOpenGatewayMetadataExtractor } from "../metadata";
import { createOpenGateway } from "../opengateway";
import {
  opengatewayNullReasoningDetailsResponse,
  opengatewayReasoningDetailsOnlyResponse,
  opengatewayReasoningResponse,
  opengatewayReasoningStreamResponse,
} from "./test-kit";

describe("OpenGateway reasoning metadata", () => {
  it("bounds a never-settling optional generate metadata hook", async () => {
    vi.useFakeTimers();
    try {
      const extractor = createOpenGatewayMetadataExtractor({
        createStreamExtractor: () => ({
          buildMetadata: () => undefined,
          processChunk: () => undefined,
        }),
        extractMetadata: () => new Promise(() => undefined),
      });
      const pending = extractor.extractMetadata({
        parsedBody: { extra: { routing: { route: "safe" } } },
      });

      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toEqual({
        opengateway: { routing: { route: "safe" } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes reasoning text and routing without raw reasoning_details metadata", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(opengatewayReasoningResponse());
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    const result = await generateText({
      model: opengateway("openai/gpt-5-mini"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(result.text).toBe("visible answer");
    expect(result.finalStep.reasoningText).toBe("concise reasoning");
    expect(result.finalStep.providerMetadata?.opengateway).toMatchObject({
      routing: { route: "openai", model: "gpt-5-mini" },
    });
    expect(
      result.finalStep.providerMetadata?.opengateway?.reasoningDetails
    ).toBeUndefined();
    expect(result.finalStep.reasoning).toContainEqual(
      expect.objectContaining({
        providerOptions: {
          opengateway: { reasoningDetailsRef: expect.any(String) },
        },
        text: "concise reasoning",
        type: "reasoning",
      })
    );
  });

  it("composes OpenGateway metadata with a user metadataExtractor", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(opengatewayReasoningResponse());
    const metadataExtractor: MetadataExtractor = {
      extractMetadata() {
        return Promise.resolve({
          opengateway: { custom: "kept" },
          custom: { marker: "kept" },
        });
      },
      createStreamExtractor() {
        return {
          processChunk(parsedChunk) {
            expect(parsedChunk).toBeDefined();
          },
          buildMetadata() {
            return { custom: { stream: "kept" } };
          },
        };
      },
    };
    const opengateway = createOpenGateway({
      apiKey: "k",
      fetch,
      metadataExtractor,
    });

    const result = await generateText({
      model: opengateway("openai/gpt-5-mini"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(result.finalStep.providerMetadata).toMatchObject({
      opengateway: {
        custom: "kept",
        routing: { route: "openai", model: "gpt-5-mini" },
      },
      custom: { marker: "kept" },
    });
    expect(
      result.finalStep.providerMetadata?.opengateway?.reasoningDetails
    ).toBeUndefined();
  });

  it("keeps model-specific reasoning_details ref-only without reasoning_content", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(opengatewayReasoningDetailsOnlyResponse());
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    const result = await generateText({
      model: opengateway("google/gemini-2.5-pro"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(result.text).toBe("visible answer");
    expect(result.finalStep.reasoningText).toBeUndefined();
    expect(
      result.finalStep.providerMetadata?.opengateway?.reasoningDetails
    ).toBeUndefined();
    expect(JSON.stringify(result.finalStep.response.messages)).toContain(
      "reasoningDetailsRef"
    );
    expect(JSON.stringify(result.finalStep.response.messages)).not.toContain(
      "encrypted"
    );
  });

  it("ignores null reasoning_details values", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(opengatewayNullReasoningDetailsResponse());
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    const result = await generateText({
      model: opengateway("deepseek/deepseek-v4-flash"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(result.text).toBe("visible answer");
    expect(JSON.stringify(result.finalStep.response.messages)).not.toContain(
      "reasoningDetailsRef"
    );
    expect(JSON.stringify(result.finalStep.response.messages)).not.toContain(
      "reasoning_details"
    );
  });

  it("preserves OpenGateway routing metadata on streamText results", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(opengatewayReasoningStreamResponse());
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    const result = streamText({
      model: opengateway("openai/gpt-5-mini"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(await result.text).toBe("stream answer");
    const finalStep = await result.finalStep;
    expect(finalStep.reasoning).toContainEqual(
      expect.objectContaining({
        type: "reasoning",
        text: "streamed reasoning",
      })
    );
    expect(finalStep.providerMetadata).toMatchObject({
      opengateway: {
        routing: { route: "openai", model: "gpt-5-mini" },
      },
    });
    expect(
      finalStep.providerMetadata?.opengateway?.reasoningDetails
    ).toBeUndefined();
  });
});
