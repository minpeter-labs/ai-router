import {
  arrayProp,
  errorResult,
  isRecord,
  recordProp,
  shape,
  stringProp,
} from "./json";
import type { JsonRecord, LiveCheckResult, RawCallPass } from "./types";

const TRAILING_SLASH = /\/$/;

const rawTool = {
  type: "function",
  function: {
    name: "report_result",
    description: "Report the requested exact value.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
} as const;

export async function fetchJson(
  baseURL: string,
  apiKey: string,
  path: string,
  body?: JsonRecord
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(
    `${baseURL.replace(TRAILING_SLASH, "")}${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : JSON.parse(text),
  };
}

export async function listModels(
  baseURL: string,
  apiKey: string
): Promise<LiveCheckResult["modelCatalog"]> {
  const { status, body } = await fetchJson(baseURL, apiKey, "/models");
  const data = isRecord(body) ? arrayProp(body, "data") : [];
  const ids = data
    .map((item) => (isRecord(item) ? stringProp(item, "id") : ""))
    .filter((id) => id.length > 0);
  return { status, count: ids.length, ids };
}

export function rawBody(model: string, reasoningEffort: string): JsonRecord {
  return {
    model,
    messages: [
      {
        role: "user",
        content:
          "Answer with exactly one short sentence: say whether 2+2 equals 4.",
      },
    ],
    reasoning_effort: reasoningEffort,
    max_tokens: 96,
    temperature: 0,
    extra: { debug: ["normalizations", "deprecations", "routing"] },
  };
}

export function rawToolBody(model: string): JsonRecord {
  return {
    model,
    messages: [
      {
        role: "user",
        content:
          "Call the report_result tool with value exactly ok. Do not answer in text.",
      },
    ],
    tools: [rawTool],
    tool_choice: { type: "function", function: { name: "report_result" } },
    max_tokens: 96,
    temperature: 0,
    extra: { debug: ["normalizations", "deprecations", "routing"] },
  };
}

export async function rawCall(
  baseURL: string,
  apiKey: string,
  body: JsonRecord
) {
  try {
    const response = await fetchJson(
      baseURL,
      apiKey,
      "/chat/completions",
      body
    );
    if (!isRecord(response.body) || response.status >= 400) {
      return errorResult(response.body, response.status);
    }
    return summarizeRaw(response.status, response.body);
  } catch (error) {
    if (error instanceof Error) {
      return errorResult(error);
    }
    return errorResult(error);
  }
}

function summarizeRaw(status: number, body: JsonRecord): RawCallPass {
  const choice = arrayProp(body, "choices").find(isRecord);
  const message = recordProp(choice ?? {}, "message");
  const toolCalls = arrayProp(message ?? {}, "tool_calls").filter(isRecord);
  const debug = recordProp(body, "debug");
  return {
    ok: true,
    status,
    finishReason: stringProp(choice, "finish_reason") || undefined,
    messageKeys: Object.keys(message ?? {}).sort(),
    contentLength: stringProp(message, "content").length,
    reasoningContentLength: stringProp(message, "reasoning_content").length,
    reasoningLength: stringProp(message, "reasoning").length,
    reasoningDetails: shape(message?.reasoning_details),
    toolCallCount: toolCalls.length,
    toolCallNames: toolCalls.map((call) =>
      stringProp(recordProp(call, "function"), "name")
    ),
    topLevelKeys: Object.keys(body).sort(),
    extraKeys: Object.keys(recordProp(body, "extra") ?? {}).sort(),
    debug: shape(debug),
    normalizations: shape(debug?.normalizations),
    routing: shape(recordProp(body, "extra")?.routing ?? body.routing),
    usage: shape(body.usage),
  };
}
