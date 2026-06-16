import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { describe, expect, it } from "vitest";
import { createOpenGateway } from "./opengateway";

const reasoningDetails = [
  { data: "encrypted-mini", format: "minimax", type: "reasoning.encrypted" },
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

function toolCallReasoningDetailsOnlyStreamResponse(): Response {
  const events = [
    {
      id: "chatcmpl-og-stream-tool",
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
      id: "chatcmpl-og-stream-tool",
      object: "chat.completion.chunk",
      created: 0,
      model: "minimax/MiniMax-M2.7",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "report_result",
                  arguments: JSON.stringify({ value: "ok" }),
                },
              },
            ],
          },
        },
      ],
    },
    {
      id: "chatcmpl-og-stream-tool",
      object: "chat.completion.chunk",
      created: 0,
      model: "minimax/MiniMax-M2.7",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
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

const reportResultTool = tool({
  description: "Report the requested exact value.",
  inputSchema: jsonSchema<{ readonly value: string }>({
    type: "object",
    additionalProperties: false,
    properties: { value: { type: "string" } },
    required: ["value"],
  }),
  execute(input) {
    return Promise.resolve({ received: input.value });
  },
});

describe("OpenGateway streamed reasoning round-trip", () => {
  it("preserves streamed reasoning_details-only tool calls into the next request", async () => {
    const { bodies, fetch } = captureBodies([
      toolCallReasoningDetailsOnlyStreamResponse(),
      completionResponse("done"),
    ]);
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    const result = streamText({
      model: opengateway("minimax/MiniMax-M2.7"),
      prompt: "Call the report_result tool with value ok.",
      tools: { report_result: reportResultTool },
      stopWhen: stepCountIs(2),
    });

    await result.consumeStream();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        reasoning_details: reasoningDetails,
      })
    );
  });
});
