import { generateText, jsonSchema, stepCountIs, streamText, tool } from "ai";
import { createOpenGateway } from "../../src/provider/opengateway/opengateway";
import { errorResult, shape } from "./json";
import type { SdkCallPass, SdkCallResult, SdkToolResult } from "./types";

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

export async function sdkGenerate(
  baseURL: string,
  apiKey: string,
  model: string,
  reasoning: "none" | "high"
): Promise<SdkCallResult> {
  try {
    const provider = createOpenGateway({ apiKey, baseURL });
    const result = await generateText({
      model: provider(model),
      prompt:
        "Answer with exactly one short sentence: say whether 3+3 equals 6.",
      reasoning,
      temperature: 0,
      maxOutputTokens: 96,
      maxRetries: 0,
    });
    return {
      ok: true,
      textLength: result.text.length,
      finishReason: result.finalStep.finishReason,
      rawFinishReason: result.finalStep.rawFinishReason,
      reasoningPartCount: result.finalStep.reasoning.length,
      reasoningTextLength: result.finalStep.reasoningText?.length ?? 0,
      providerMetadata: shape(result.finalStep.providerMetadata?.opengateway),
      usage: shape(result.finalStep.usage),
    } satisfies SdkCallPass;
  } catch (error) {
    if (error instanceof Error) {
      return errorResult(error);
    }
    return errorResult(error);
  }
}

export async function sdkStream(
  baseURL: string,
  apiKey: string,
  model: string
): Promise<SdkCallResult> {
  try {
    const provider = createOpenGateway({ apiKey, baseURL });
    const result = streamText({
      model: provider(model),
      prompt:
        "Answer with exactly one short sentence: say whether 4+4 equals 8.",
      reasoning: "high",
      temperature: 0,
      maxOutputTokens: 96,
      maxRetries: 0,
      onError() {
        return;
      },
    });
    const text = await result.text;
    const finalStep = await result.finalStep;
    return {
      ok: true,
      textLength: text.length,
      finishReason: finalStep.finishReason,
      rawFinishReason: finalStep.rawFinishReason,
      reasoningPartCount: finalStep.reasoning.length,
      reasoningTextLength: finalStep.reasoningText?.length ?? 0,
      providerMetadata: shape(finalStep.providerMetadata?.opengateway),
      usage: shape(finalStep.usage),
    };
  } catch (error) {
    if (error instanceof Error) {
      return errorResult(error);
    }
    return errorResult(error);
  }
}

export async function sdkTool(
  baseURL: string,
  apiKey: string,
  model: string
): Promise<SdkToolResult> {
  try {
    const provider = createOpenGateway({ apiKey, baseURL });
    const result = await generateText({
      model: provider(model),
      prompt:
        "Call the report_result tool with value exactly ok. Do not answer in text.",
      tools: { report_result: reportResultTool },
      toolChoice: { type: "tool", toolName: "report_result" },
      stopWhen: stepCountIs(2),
      temperature: 0,
      maxOutputTokens: 96,
      maxRetries: 0,
    });
    return {
      ok: true,
      finishReason: result.finalStep.finishReason,
      stepCount: result.steps.length,
      toolCallCount: result.toolCalls.length,
      toolResultCount: result.toolResults.length,
      toolNames: result.toolCalls.map((call) => call.toolName),
      textLength: result.text.length,
    };
  } catch (error) {
    if (error instanceof Error) {
      return errorResult(error);
    }
    return errorResult(error);
  }
}
