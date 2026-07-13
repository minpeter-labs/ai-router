export function opengatewayReasoningResponse(): Response {
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

export function opengatewayReasoningDetailsOnlyResponse(): Response {
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

export function opengatewayNullReasoningDetailsResponse(): Response {
  return Response.json({
    id: "chatcmpl-og",
    object: "chat.completion",
    created: 0,
    model: "deepseek/deepseek-v4-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "visible answer",
          reasoning_details: null,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
}

export function opengatewayReasoningStreamResponse(): Response {
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
