import {
  arrayProp,
  isRecord,
  recordProp,
  stringProp,
} from "../opengateway-live/json";
import type { JsonRecord } from "../opengateway-live/types";
import { summarizeEvents } from "./summary";
import type { StreamEvent, StreamProbe } from "./types";

const DATA_PREFIX = /^data:\s*/;
const TRAILING_SLASH = /\/$/;

function streamRequest(model: string): JsonRecord {
  return {
    max_tokens: 384,
    messages: [
      {
        content:
          "Think briefly, then answer in one sentence: what is 17 plus 25?",
        role: "user",
      },
    ],
    model,
    reasoning_effort: "high",
    stream: true,
    temperature: 0,
  };
}

function summarizeDelta(
  index: number,
  chunk: unknown
): StreamEvent | undefined {
  if (!isRecord(chunk)) {
    return;
  }
  const choice = arrayProp(chunk, "choices").find(isRecord);
  if (choice === undefined) {
    return;
  }
  const delta = recordProp(choice, "delta");
  return {
    contentLength: stringProp(delta, "content").length,
    finishReason: stringProp(choice, "finish_reason") || undefined,
    index,
    keys: Object.keys(delta ?? {}).sort(),
    reasoningContentLength: stringProp(delta, "reasoning_content").length,
    reasoningLength: stringProp(delta, "reasoning").length,
    textDeltaLength: 0,
  };
}

function parseDataLine(line: string): unknown | undefined {
  const payload = line.replace(DATA_PREFIX, "");
  if (payload === "[DONE]" || payload.length === 0) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return;
    }
    throw error;
  }
}

function collectSseEvents(buffer: string): readonly unknown[] {
  const events: unknown[] = [];
  for (const line of buffer.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const parsed = parseDataLine(line);
    if (parsed !== undefined) {
      events.push(parsed);
    }
  }
  return events;
}

function pushParsedEvents(events: StreamEvent[], block: string): void {
  for (const parsed of collectSseEvents(block)) {
    const event = summarizeDelta(events.length, parsed);
    if (event !== undefined) {
      events.push(event);
    }
  }
}

export async function rawStreamProbe(
  baseURL: string,
  apiKey: string,
  model: string
): Promise<StreamProbe> {
  const response = await fetch(
    `${baseURL.replace(TRAILING_SLASH, "")}/chat/completions`,
    {
      body: JSON.stringify(streamRequest(model)),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
    }
  );
  if (response.status >= 400) {
    return {
      message: await response.text(),
      ok: false,
      status: response.status,
    };
  }
  if (response.body === null) {
    return {
      message: "missing response body",
      ok: false,
      status: response.status,
    };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  const events: StreamEvent[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    carry += decoder.decode(result.value, { stream: true });
    const blocks = carry.split("\n\n");
    carry = blocks.pop() ?? "";
    for (const block of blocks) {
      pushParsedEvents(events, block);
    }
  }
  pushParsedEvents(events, carry + decoder.decode());
  return summarizeEvents(events);
}
