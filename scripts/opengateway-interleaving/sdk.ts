import { streamText } from "ai";
import { createOpenGateway } from "../../src/provider/opengateway/opengateway";
import {
  arrayProp,
  isRecord,
  recordProp,
  stringProp,
} from "../opengateway-live/json";
import { summarizeEvents } from "./summary";
import type { StreamEvent, StreamProbe } from "./types";

function summarizeSdkPart(index: number, part: unknown): StreamEvent {
  const record = isRecord(part) ? part : {};
  const type = stringProp(record, "type") || undefined;
  const textLength = stringProp(record, "text").length;
  const isReasoning = type?.includes("reasoning") === true;
  return {
    contentLength: 0,
    index,
    keys: Object.keys(record).sort(),
    reasoningContentLength: isReasoning ? textLength : 0,
    reasoningLength: 0,
    textDeltaLength: type === "text-delta" ? textLength : 0,
    type,
  };
}

export async function sdkStreamProbe(
  baseURL: string,
  apiKey: string,
  model: string
): Promise<StreamProbe> {
  try {
    const provider = createOpenGateway({ apiKey, baseURL });
    const result = streamText({
      maxOutputTokens: 384,
      maxRetries: 0,
      model: provider(model),
      onError() {
        return;
      },
      prompt: "Think briefly, then answer in one sentence: what is 17 plus 25?",
      reasoning: "high",
      temperature: 0,
    });
    const events: StreamEvent[] = [];
    for await (const part of result.stream) {
      events.push(summarizeSdkPart(events.length, part));
    }
    if (events.some((event) => event.type === "error")) {
      return { message: "stream emitted error part", ok: false };
    }
    const finalStep = await result.finalStep;
    const providerMetadata = isRecord(finalStep.providerMetadata)
      ? recordProp(finalStep.providerMetadata, "opengateway")
      : undefined;
    const firstReasoningPart = finalStep.reasoning.find(
      (part) => part.type === "reasoning"
    );
    const reasoningProviderMetadata = isRecord(
      firstReasoningPart?.providerOptions
    )
      ? recordProp(firstReasoningPart.providerOptions, "opengateway")
      : undefined;
    return summarizeEvents(events, {
      finalReasoningPartCount: finalStep.reasoning.length,
      finalReasoningProviderDetailsLength: arrayProp(
        reasoningProviderMetadata ?? {},
        "reasoningDetails"
      ).length,
      finalReasoningTextLength: finalStep.reasoningText?.length ?? 0,
      providerMetadataKeys: Object.keys(providerMetadata ?? {}).sort(),
      providerReasoningDetailsLength: arrayProp(
        providerMetadata ?? {},
        "reasoningDetails"
      ).length,
    });
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}
