import type { MetadataExtractor } from "@ai-sdk/openai-compatible";
import {
  isJSONArray,
  isJSONObject,
  isJSONValue,
  type JSONObject,
  type JSONValue,
  type SharedV4ProviderMetadata,
} from "@ai-sdk/provider";

const OPENGATEWAY_METADATA_KEY = "opengateway";

function asJsonList(value: JSONValue): JSONValue[] {
  return isJSONArray(value) ? value : [value];
}

function jsonValueKey(value: JSONValue): string {
  return JSON.stringify(value) ?? "undefined";
}

export function appendUniqueJsonDetails(
  target: JSONValue[],
  details: readonly JSONValue[]
): void {
  const seen = new Set(target.map(jsonValueKey));
  for (const detail of details) {
    const key = jsonValueKey(detail);
    if (!seen.has(key)) {
      seen.add(key);
      target.push(detail);
    }
  }
}

export function collectChoiceReasoningDetails(body: unknown): JSONValue[] {
  if (!isJSONObject(body)) {
    return [];
  }

  const choices = body.choices;
  if (!isJSONArray(choices)) {
    return [];
  }

  const details: JSONValue[] = [];
  for (const choice of choices) {
    if (!isJSONObject(choice)) {
      continue;
    }

    const message = choice.message;
    if (isJSONObject(message) && isJSONValue(message.reasoning_details)) {
      appendUniqueJsonDetails(details, asJsonList(message.reasoning_details));
    }

    const delta = choice.delta;
    if (isJSONObject(delta) && isJSONValue(delta.reasoning_details)) {
      appendUniqueJsonDetails(details, asJsonList(delta.reasoning_details));
    }
  }
  return details;
}

function extractRouting(body: unknown): JSONValue | undefined {
  if (!isJSONObject(body)) {
    return;
  }

  const extra = body.extra;
  if (isJSONObject(extra) && isJSONValue(extra.routing)) {
    return extra.routing;
  }

  return isJSONValue(body.routing) ? body.routing : undefined;
}

function buildOpenGatewayMetadata(
  routing: JSONValue | undefined
): SharedV4ProviderMetadata | undefined {
  const metadata: JSONObject = {};
  if (routing !== undefined) {
    metadata.routing = routing;
  }
  return Object.keys(metadata).length > 0
    ? { [OPENGATEWAY_METADATA_KEY]: metadata }
    : undefined;
}

function extractOpenGatewayMetadata(
  body: unknown
): SharedV4ProviderMetadata | undefined {
  return buildOpenGatewayMetadata(extractRouting(body));
}

function mergeProviderMetadata(
  first?: SharedV4ProviderMetadata,
  second?: SharedV4ProviderMetadata
): SharedV4ProviderMetadata | undefined {
  if (first === undefined) {
    return second;
  }
  if (second === undefined) {
    return first;
  }

  const merged: SharedV4ProviderMetadata = { ...first };
  for (const [providerName, metadata] of Object.entries(second)) {
    merged[providerName] = {
      ...(merged[providerName] ?? {}),
      ...metadata,
    };
  }
  return merged;
}

export function createOpenGatewayMetadataExtractor(
  userExtractor?: MetadataExtractor
): MetadataExtractor {
  return {
    async extractMetadata({ parsedBody }) {
      const opengatewayMetadata = extractOpenGatewayMetadata(parsedBody);
      const userMetadata = await userExtractor?.extractMetadata({ parsedBody });
      return mergeProviderMetadata(opengatewayMetadata, userMetadata);
    },
    createStreamExtractor() {
      const userStreamExtractor = userExtractor?.createStreamExtractor();
      let routing: JSONValue | undefined;

      return {
        processChunk(parsedChunk) {
          userStreamExtractor?.processChunk(parsedChunk);
          const chunkRouting = extractRouting(parsedChunk);
          if (chunkRouting !== undefined) {
            routing = chunkRouting;
          }
        },
        buildMetadata() {
          const opengatewayMetadata = buildOpenGatewayMetadata(routing);
          const userMetadata = userStreamExtractor?.buildMetadata();
          return mergeProviderMetadata(opengatewayMetadata, userMetadata);
        },
      };
    },
  };
}
