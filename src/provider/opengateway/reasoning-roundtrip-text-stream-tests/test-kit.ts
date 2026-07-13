export const reasoningDetails = [
  { data: "encrypted-mini", format: "minimax", type: "reasoning.encrypted" },
];
export const laterReasoningDetails = [
  { data: "encrypted-later", format: "minimax", type: "reasoning.encrypted" },
];

export function completionResponse(content: string): Response {
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

export function textReasoningDetailsOnlyStreamResponse(): Response {
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

export function repeatedReasoningDetailsTextStreamResponse(): Response {
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
    ...["one ", "two ", "three"].map((content) => ({
      id: "chatcmpl-og-stream-text",
      object: "chat.completion.chunk",
      created: 0,
      model: "minimax/MiniMax-M2.7",
      choices: [{ index: 0, delta: { content } }],
    })),
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

export function captureBodies(responses: readonly Response[]): {
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
