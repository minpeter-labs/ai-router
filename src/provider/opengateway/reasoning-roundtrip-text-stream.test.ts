import { generateText, streamText, toUIMessageStream } from "ai";
import { describe, expect, it } from "vitest";
import { createOpenGateway } from "./opengateway";

const reasoningDetails = [
  { data: "encrypted-mini", format: "minimax", type: "reasoning.encrypted" },
];
const laterReasoningDetails = [
  { data: "encrypted-later", format: "minimax", type: "reasoning.encrypted" },
];

function completionResponse(content: string): Response {
  return Response.json({
    id: "chatcmpl-og-final",
    object: "chat.completion",
    created: 0,
    model: "minimax/MiniMax-M2.7",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function textReasoningDetailsOnlyStreamResponse(): Response {
  const events = [
    {
      id: "chatcmpl-og-stream-text",
      object: "chat.completion.chunk",
      created: 0,
      model: "minimax/MiniMax-M2.7",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_details: reasoningDetails,
          },
        },
      ],
    },
    {
      id: "chatcmpl-og-stream-text",
      object: "chat.completion.chunk",
      created: 0,
      model: "minimax/MiniMax-M2.7",
      choices: [{ index: 0, delta: { content: "stream " } }],
    },
    {
      id: "chatcmpl-og-stream-text",
      object: "chat.completion.chunk",
      created: 0,
      model: "minimax/MiniMax-M2.7",
      choices: [
        {
          index: 0,
          delta: {
            content: "answer",
            reasoning_details: laterReasoningDetails,
          },
        },
      ],
    },
    {
      id: "chatcmpl-og-stream-text",
      object: "chat.completion.chunk",
      created: 0,
      model: "minimax/MiniMax-M2.7",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function captureBodies(responses: readonly Response[]): {
  readonly bodies: Record<string, unknown>[];
  readonly fetch: typeof globalThis.fetch;
} {
  const bodies: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    if (typeof init?.body === "string") {
      bodies.push(JSON.parse(init.body));
    }
    return Promise.resolve(
      responses[bodies.length - 1] ?? completionResponse("ok")
    );
  };
  return { bodies, fetch };
}

describe("OpenGateway streamed text reasoning round-trip", () => {
  it("preserves streamed reasoning_details-only text answers into the next request", async () => {
    const { bodies, fetch } = captureBodies([
      textReasoningDetailsOnlyStreamResponse(),
      completionResponse("done"),
    ]);
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    const first = streamText({
      model: opengateway("minimax/MiniMax-M2.7"),
      prompt: "answer briefly",
    });

    const uiChunks: unknown[] = [];
    for await (const chunk of toUIMessageStream({ stream: first.stream })) {
      uiChunks.push(chunk);
    }
    expect(JSON.stringify(uiChunks)).toContain("stream ");
    expect(JSON.stringify(uiChunks)).toContain("answer");
    expect(JSON.stringify(uiChunks)).not.toContain("encrypted-mini");
    expect(JSON.stringify(uiChunks)).not.toContain("encrypted-later");

    const firstStep = await first.finalStep;
    expect(JSON.stringify(firstStep.response.messages)).not.toContain(
      "encrypted-mini"
    );
    expect(JSON.stringify(firstStep.response.messages)).not.toContain(
      "encrypted-later"
    );

    await generateText({
      model: opengateway("minimax/MiniMax-M2.7"),
      messages: [
        { role: "user", content: "first" },
        ...firstStep.response.messages,
        { role: "user", content: "continue" },
      ],
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages).toContainEqual(
      expect.objectContaining({
        reasoning_details: [...reasoningDetails, ...laterReasoningDetails],
        role: "assistant",
      })
    );
  });
});
