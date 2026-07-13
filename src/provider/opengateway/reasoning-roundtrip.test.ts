import { generateText, jsonSchema, stepCountIs, streamText, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createOpenGateway } from "./opengateway";
import { createOpenGatewayReasoningRoundtripMiddleware } from "./reasoning-roundtrip";

const reasoningDetails = [
  { data: "encrypted-mini", format: "minimax", type: "reasoning.encrypted" },
];

describe("createOpenGatewayReasoningRoundtripMiddleware", () => {
  it("consumes Promise-valued settings and store slots", async () => {
    expect(() =>
      createOpenGatewayReasoningRoundtripMiddleware(
        Promise.reject(new Error("async middleware settings")) as never
      )
    ).toThrow("reasoning roundtrip settings must be synchronous");
    expect(() =>
      createOpenGatewayReasoningRoundtripMiddleware({
        reasoningDetailsStore: Promise.reject(
          new Error("async configured store")
        ) as never,
      })
    ).toThrow("reasoningDetailsStore must be synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes Promise-valued hook argument siblings before invocation", async () => {
    const middleware = createOpenGatewayReasoningRoundtripMiddleware();
    await expect(
      middleware.transformParams?.(
        Promise.reject(new Error("async transform arguments")) as never
      )
    ).rejects.toThrow("hook arguments must be synchronous");

    const generateOptions = Object.defineProperties(
      {},
      {
        doGenerate: {
          get() {
            throw new Error("generate accessor failed");
          },
        },
        doStream: {
          value: Promise.reject(new Error("async stream sibling")),
        },
      }
    );
    await expect(
      middleware.wrapGenerate?.(generateOptions as never)
    ).rejects.toThrow("generate accessor failed");

    await expect(
      middleware.wrapStream?.({
        doGenerate: Promise.reject(new Error("async generate sibling")),
        doStream: () => Promise.reject(new Error("unused")),
        model: {
          doStream: Promise.reject(new Error("async model method")),
        },
        params: Promise.reject(new Error("async params")),
      } as never)
    ).rejects.toThrow("hook fields must be synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes Promise-valued generate and stream result siblings", async () => {
    const middleware = createOpenGatewayReasoningRoundtripMiddleware();
    await expect(
      middleware.wrapGenerate?.({
        doGenerate: () =>
          Promise.resolve({
            content: Promise.reject(new Error("async content")),
            finishReason: Promise.reject(new Error("async finish reason")),
            usage: Promise.reject(new Error("async usage")),
            warnings: Promise.reject(new Error("async warnings")),
          } as never),
        doStream: () => Promise.reject(new Error("unused")),
        model: {} as never,
        params: { prompt: [] },
      })
    ).rejects.toThrow("reasoning generate result fields must be synchronous");

    await expect(
      middleware.wrapGenerate?.({
        doGenerate: () =>
          Promise.resolve({
            content: [],
            finishReason: { raw: "stop", unified: "stop" },
            response: {
              body: Promise.reject(new Error("async response body")),
              headers: Promise.reject(new Error("async response headers")),
            },
            usage: {},
            warnings: [],
          } as never),
        doStream: () => Promise.reject(new Error("unused")),
        model: {} as never,
        params: { prompt: [] },
      })
    ).rejects.toThrow("reasoning generate response fields must be synchronous");

    await expect(
      middleware.wrapStream?.({
        doGenerate: () => Promise.reject(new Error("unused")),
        doStream: () => Promise.reject(new Error("unused")),
        model: {
          doStream: () =>
            Promise.resolve({
              request: Promise.reject(new Error("async request")),
              response: Promise.reject(new Error("async response")),
              stream: Promise.reject(new Error("async stream")),
            } as never),
        } as never,
        params: { prompt: [] },
      })
    ).rejects.toThrow("reasoning stream result fields must be synchronous");

    await expect(
      middleware.wrapStream?.({
        doGenerate: () => Promise.reject(new Error("unused")),
        doStream: () => Promise.reject(new Error("unused")),
        model: {
          doStream: () =>
            Promise.resolve({
              stream: {
                pipeThrough: Promise.reject(
                  new Error("async pipeThrough method")
                ),
              },
            } as never),
        } as never,
        params: { prompt: [] },
      })
    ).rejects.toThrow("result.stream.pipeThrough must be a function");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("cancels opened streams when transform setup fails", async () => {
    const middleware = createOpenGatewayReasoningRoundtripMiddleware();
    const OriginalTransformStream = globalThis.TransformStream;
    let cancellations = 0;
    const source = new ReadableStream({
      cancel() {
        cancellations += 1;
      },
    });
    vi.stubGlobal(
      "TransformStream",
      class {
        constructor() {
          throw new Error("transform unavailable");
        }
      }
    );
    try {
      await expect(
        middleware.wrapStream?.({
          doGenerate: () => Promise.reject(new Error("unused")),
          doStream: () => Promise.reject(new Error("unused")),
          model: {
            doStream: () => Promise.resolve({ stream: source }),
          } as never,
          params: { prompt: [] },
        })
      ).rejects.toThrow("transform unavailable");
      expect(cancellations).toBe(1);
    } finally {
      vi.stubGlobal("TransformStream", OriginalTransformStream);
    }

    let customCancellations = 0;
    await expect(
      middleware.wrapStream?.({
        doGenerate: () => Promise.reject(new Error("unused")),
        doStream: () => Promise.reject(new Error("unused")),
        model: {
          doStream: () =>
            Promise.resolve({
              stream: {
                cancel() {
                  customCancellations += 1;
                  return Promise.resolve();
                },
                pipeThrough() {
                  return Promise.reject(new Error("async pipe result"));
                },
              },
            } as never),
        } as never,
        params: { prompt: [] },
      })
    ).rejects.toThrow("pipeThrough must return a synchronous stream");
    expect(customCancellations).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

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
