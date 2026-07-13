import { generateText, stepCountIs, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { createOpenGateway } from "../opengateway";
import {
  captureBodies,
  completionResponse,
  reasoningDetails,
  reasoningStreamResponse,
  reportResultTool,
  toolCallReasoningResponse,
} from "./test-kit";

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
