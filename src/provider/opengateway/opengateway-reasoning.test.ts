import type { MetadataExtractor } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { createOpenGateway } from "./opengateway";

function opengatewayReasoningResponse(): Response {
  return Response.json({
    id: "chatcmpl-og",
    object: "chat.completion",
    created: 0,
    model: "openai/gpt-5-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "visible answer",
          reasoning_content: "concise reasoning",
          reasoning_details: [
            { type: "reasoning.summary", text: "model-specific detail" },
          ],
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    extra: {
      routing: { route: "openai", model: "gpt-5-mini" },
    },
  });
}

function opengatewayReasoningDetailsOnlyResponse(): Response {
  return Response.json({
    id: "chatcmpl-og",
    object: "chat.completion",
    created: 0,
    model: "google/gemini-2.5-pro",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "visible answer",
          reasoning_details: {
            provider: "google",
            encrypted: true,
          },
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
}

function opengatewayReasoningStreamResponse(): Response {
  const events = [
    {
      id: "chatcmpl-og",
      object: "chat.completion.chunk",
      created: 0,
      model: "openai/gpt-5-mini",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_content: "streamed reasoning",
            reasoning_details: [
              { type: "reasoning.summary", text: "stream detail" },
            ],
          },
        },
      ],
    },
    {
      id: "chatcmpl-og",
      object: "chat.completion.chunk",
      created: 0,
      model: "openai/gpt-5-mini",
      choices: [{ index: 0, delta: { content: "stream answer" } }],
    },
    {
      id: "chatcmpl-og",
      object: "chat.completion.chunk",
      created: 0,
      model: "openai/gpt-5-mini",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      extra: { routing: { route: "openai", model: "gpt-5-mini" } },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OpenGateway reasoning metadata", () => {
  it("preserves OpenGateway reasoning fields on generateText results", async () => {
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
      reasoningDetails: [
        { type: "reasoning.summary", text: "model-specific detail" },
      ],
      routing: { route: "openai", model: "gpt-5-mini" },
    });
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
        reasoningDetails: [
          { type: "reasoning.summary", text: "model-specific detail" },
        ],
        routing: { route: "openai", model: "gpt-5-mini" },
      },
      custom: { marker: "kept" },
    });
  });

  it("keeps model-specific reasoning_details even without reasoning_content", async () => {
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
    expect(result.finalStep.providerMetadata?.opengateway).toMatchObject({
      reasoningDetails: [{ provider: "google", encrypted: true }],
    });
  });

  it("preserves OpenGateway reasoning metadata on streamText results", async () => {
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
        reasoningDetails: [
          { type: "reasoning.summary", text: "stream detail" },
        ],
        routing: { route: "openai", model: "gpt-5-mini" },
      },
    });
  });
});
