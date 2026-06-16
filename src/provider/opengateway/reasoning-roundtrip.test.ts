import { generateText, jsonSchema, stepCountIs, streamText, tool } from "ai";
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

function toolCallReasoningResponse(): Response {
  return Response.json({
    id: "chatcmpl-og-tool",
    object: "chat.completion",
    created: 0,
    model: "minimax/MiniMax-M2.7",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "call the reporting tool",
          reasoning_details: reasoningDetails,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "report_result",
                arguments: JSON.stringify({ value: "ok" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function reasoningStreamResponse(): Response {
  const events = [
    {
      id: "chatcmpl-og-stream",
      object: "chat.completion.chunk",
      created: 0,
      model: "minimax/MiniMax-M2.7",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_content: "streamed tool planning",
            reasoning_details: reasoningDetails,
          },
        },
      ],
    },
    {
      id: "chatcmpl-og-stream",
      object: "chat.completion.chunk",
      created: 0,
      model: "minimax/MiniMax-M2.7",
      choices: [{ index: 0, delta: { content: "stream answer" } }],
    },
    {
      id: "chatcmpl-og-stream",
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

describe("OpenGateway reasoning round-trip", () => {
  it("sends persisted reasoning_details from assistant reasoning metadata", async () => {
    const { bodies, fetch } = captureBodies([completionResponse("ok")]);
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    await generateText({
      model: opengateway("minimax/MiniMax-M2.7"),
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "prior thinking",
              providerOptions: {
                opengateway: { reasoningDetails },
              },
            },
            { type: "text", text: "prior answer" },
          ],
        },
        { role: "user", content: "continue" },
      ],
    });

    expect(bodies[0]?.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        reasoning_content: "prior thinking",
        reasoning_details: reasoningDetails,
      })
    );
  });

  it("does not replay null reasoning_details from assistant metadata", async () => {
    const { bodies, fetch } = captureBodies([completionResponse("ok")]);
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    await generateText({
      model: opengateway("minimax/MiniMax-M2.7"),
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "prior thinking",
              providerOptions: {
                opengateway: { reasoningDetails: null },
              },
            },
            { type: "text", text: "prior answer" },
          ],
        },
        { role: "user", content: "continue" },
      ],
    });

    expect(bodies[0]?.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        reasoning_content: "prior thinking",
      })
    );
    expect(JSON.stringify(bodies[0])).not.toContain("reasoning_details");
  });

  it("preserves reasoning_details from a tool-call step into the next request", async () => {
    const { bodies, fetch } = captureBodies([
      toolCallReasoningResponse(),
      completionResponse("done"),
    ]);
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    await generateText({
      model: opengateway("minimax/MiniMax-M2.7"),
      prompt: "Call the report_result tool with value ok.",
      tools: { report_result: reportResultTool },
      stopWhen: stepCountIs(2),
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        reasoning_content: "call the reporting tool",
        reasoning_details: reasoningDetails,
      })
    );
  });

  it("keeps streamed reasoning_details on the final reasoning part", async () => {
    const opengateway = createOpenGateway({
      apiKey: "k",
      fetch: () => Promise.resolve(reasoningStreamResponse()),
    });

    const result = streamText({
      model: opengateway("minimax/MiniMax-M2.7"),
      prompt: "answer briefly",
      reasoning: "high",
    });

    expect(await result.text).toBe("stream answer");
    const finalStep = await result.finalStep;
    expect(finalStep.reasoning).toContainEqual(
      expect.objectContaining({
        providerOptions: {
          opengateway: { reasoningDetailsRef: expect.any(String) },
        },
        text: "streamed tool planning",
        type: "reasoning",
      })
    );
  });
});
