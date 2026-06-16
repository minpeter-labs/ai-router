import { writeFile } from "node:fs/promises";
import { isJSONValue, type JSONValue } from "@ai-sdk/provider";
import type { AssistantContent, ModelMessage } from "ai";
import { generateText } from "ai";
import { createOpenGateway } from "../src/provider/opengateway/opengateway";
import {
  arrayProp,
  errorResult,
  isRecord,
  recordProp,
  requiredOpenGatewayApiKey,
  requiredOpenGatewayBaseURL,
  shape,
  stringProp,
} from "./opengateway-live/json";
import { fetchJson } from "./opengateway-live/raw";
import type { JsonRecord } from "./opengateway-live/types";
import { csvModels } from "./opengateway-roundtrip/models";
import type {
  ModelRoundtrip,
  RoundtripPass,
  RoundtripReport,
  RoundtripResult,
} from "./opengateway-roundtrip/types";

function jsonList(value: unknown): JSONValue[] {
  if (Array.isArray(value)) {
    return value.filter(isJSONValue);
  }
  return isJSONValue(value) ? [value] : [];
}

function firstRequest(model: string): JsonRecord {
  return {
    max_tokens: 192,
    messages: [
      {
        content: "Think briefly, then answer in one sentence: what is 9+8?",
        role: "user",
      },
    ],
    model,
    reasoning_effort: "high",
    temperature: 0,
  };
}

function firstAssistant(body: unknown): JsonRecord | undefined {
  const choice = isRecord(body)
    ? arrayProp(body, "choices").find(isRecord)
    : undefined;
  return recordProp(choice ?? {}, "message");
}

function replayAssistant(message: JsonRecord): JsonRecord {
  const reasoningContent = stringProp(message, "reasoning_content");
  return {
    content: stringProp(message, "content"),
    ...(reasoningContent.length > 0
      ? { reasoning_content: reasoningContent }
      : {}),
    ...(message.reasoning_details === undefined
      ? {}
      : { reasoning_details: message.reasoning_details }),
    role: "assistant",
  };
}

function followupRequest(model: string, assistant: JsonRecord): JsonRecord {
  return {
    max_tokens: 64,
    messages: [
      {
        content: "Think briefly, then answer in one sentence: what is 9+8?",
        role: "user",
      },
      replayAssistant(assistant),
      {
        content: "Now answer in one short sentence: what is 1+1?",
        role: "user",
      },
    ],
    model,
    reasoning_effort: "high",
    temperature: 0,
  };
}

function assistantSummary(
  body: JsonRecord | undefined
): RoundtripPass["followup"] {
  const messages = body === undefined ? [] : arrayProp(body, "messages");
  const assistant = messages
    .filter(isRecord)
    .find((message) => stringProp(message, "role") === "assistant");
  return {
    assistantMessageKeys: Object.keys(assistant ?? {}).sort(),
    reasoningContentLength: stringProp(assistant, "reasoning_content").length,
    reasoningDetails: shape(assistant?.reasoning_details),
  };
}

function firstSummary(message: JsonRecord): RoundtripPass["first"] {
  return {
    contentLength: stringProp(message, "content").length,
    finishReason: undefined,
    reasoningContentLength: stringProp(message, "reasoning_content").length,
    reasoningDetails: shape(message.reasoning_details),
  };
}

async function rawRoundtrip(
  baseURL: string,
  apiKey: string,
  model: string
): Promise<RoundtripResult> {
  try {
    const first = await fetchJson(
      baseURL,
      apiKey,
      "/chat/completions",
      firstRequest(model)
    );
    const assistant = firstAssistant(first.body);
    if (assistant === undefined || first.status >= 400) {
      return errorResult(first.body, first.status);
    }
    const followup = await fetchJson(
      baseURL,
      apiKey,
      "/chat/completions",
      followupRequest(model, assistant)
    );
    if (followup.status >= 400) {
      return errorResult(followup.body, followup.status);
    }
    return {
      first: firstSummary(assistant),
      followup: {
        ...assistantSummary(followupRequest(model, assistant)),
        status: followup.status,
      },
      ok: true,
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error : String(error));
  }
}

function sdkMessages(assistant: JsonRecord): ModelMessage[] {
  const content: Exclude<AssistantContent, string> = [];
  const reasoningContent = stringProp(assistant, "reasoning_content");
  const reasoningDetails = jsonList(assistant.reasoning_details);
  if (reasoningContent.length > 0 || reasoningDetails.length > 0) {
    content.push({
      type: "reasoning" as const,
      text: reasoningContent,
      ...(reasoningDetails.length > 0
        ? { providerOptions: { opengateway: { reasoningDetails } } }
        : {}),
    });
  }
  content.push({
    type: "text" as const,
    text: stringProp(assistant, "content"),
  });
  return [
    {
      role: "user" as const,
      content: "Think briefly, then answer in one sentence: what is 9+8?",
    },
    { role: "assistant" as const, content },
    {
      role: "user" as const,
      content: "Now answer in one short sentence: what is 1+1?",
    },
  ];
}

async function sdkRoundtrip(
  baseURL: string,
  apiKey: string,
  model: string
): Promise<RoundtripResult> {
  try {
    const first = await fetchJson(
      baseURL,
      apiKey,
      "/chat/completions",
      firstRequest(model)
    );
    const assistant = firstAssistant(first.body);
    if (assistant === undefined || first.status >= 400) {
      return errorResult(first.body, first.status);
    }

    const bodies: JsonRecord[] = [];
    const recordingFetch: typeof globalThis.fetch = async (input, init) => {
      if (typeof init?.body === "string") {
        const parsed: unknown = JSON.parse(init.body);
        if (isRecord(parsed)) {
          bodies.push(parsed);
        }
      }
      return await fetch(input, init);
    };
    const provider = createOpenGateway({
      apiKey,
      baseURL,
      fetch: recordingFetch,
    });
    await generateText({
      maxOutputTokens: 64,
      maxRetries: 0,
      messages: sdkMessages(assistant),
      model: provider(model),
      reasoning: "high",
      temperature: 0,
    });

    return {
      first: firstSummary(assistant),
      followup: assistantSummary(bodies[0]),
      ok: true,
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error : String(error));
  }
}

async function runModel(
  baseURL: string,
  apiKey: string,
  model: string
): Promise<ModelRoundtrip> {
  return {
    model,
    raw: await rawRoundtrip(baseURL, apiKey, model),
    sdk: await sdkRoundtrip(baseURL, apiKey, model),
  };
}

async function main(): Promise<void> {
  const apiKey = requiredOpenGatewayApiKey();
  const baseURL = requiredOpenGatewayBaseURL();
  const results: ModelRoundtrip[] = [];
  for (const model of csvModels()) {
    results.push(await runModel(baseURL, apiKey, model));
  }
  const report: RoundtripReport = {
    baseURL,
    generatedAt: new Date().toISOString(),
    results,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const out = process.env.AI_ROUNDTRIP_OUT;
  if (out !== undefined && out.length > 0) {
    await writeFile(out, json);
    return;
  }
  process.stdout.write(json);
}

await main();
