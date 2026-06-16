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
      details.push(...asJsonList(message.reasoning_details));
    }

    const delta = choice.delta;
    if (isJSONObject(delta) && isJSONValue(delta.reasoning_details)) {
      details.push(...asJsonList(delta.reasoning_details));
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

function buildOpenGatewayMetadata({
  reasoningDetails,
  routing,
}: {
  reasoningDetails: JSONValue[];
  routing?: JSONValue;
}): SharedV4ProviderMetadata | undefined {
  const metadata: JSONObject = {};
  if (reasoningDetails.length > 0) {
    metadata.reasoningDetails = reasoningDetails;
  }
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
  return buildOpenGatewayMetadata({
    reasoningDetails: collectChoiceReasoningDetails(body),
    routing: extractRouting(body),
  });
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
      const reasoningDetails: JSONValue[] = [];
      let routing: JSONValue | undefined;

      return {
        processChunk(parsedChunk) {
          userStreamExtractor?.processChunk(parsedChunk);
          reasoningDetails.push(...collectChoiceReasoningDetails(parsedChunk));
          const chunkRouting = extractRouting(parsedChunk);
          if (chunkRouting !== undefined) {
            routing = chunkRouting;
          }
        },
        buildMetadata() {
          const opengatewayMetadata = buildOpenGatewayMetadata({
            reasoningDetails,
            routing,
          });
          const userMetadata = userStreamExtractor?.buildMetadata();
          return mergeProviderMetadata(opengatewayMetadata, userMetadata);
        },
      };
    },
  };
}
