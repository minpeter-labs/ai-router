import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";

import { createOpenGatewayMetadataExtractor } from "./metadata";
import { opengatewayReasoningRoundtripMiddleware } from "./reasoning-roundtrip";

const DEFAULT_BASE_URL = "https://apis.opengateway.ai/v1";

export interface CreateOpenGatewaySettings
  extends Omit<
    OpenAICompatibleProviderSettings,
    "name" | "baseURL" | "transformRequestBody"
  > {
  /** OpenGateway API key. Defaults to `process.env.OPENGATEWAY_API_KEY`. */
  apiKey?: string;
  /** Override the base URL. Defaults to the OpenGateway v1 endpoint. */
  baseURL?: string;
}

/**
 * OpenGateway provider built on `@ai-sdk/openai-compatible`.
 *
 * OpenGateway accepts OpenAI-compatible Chat Completions requests and routes
 * `owner/model` IDs such as `openai/gpt-4o-mini` or `google/gemini-2.5-pro`.
 * The plain AI SDK `reasoning` option is passed through as `reasoning_effort`.
 * `reasoning: 'none'` is left to the AI SDK default, which omits the field.
 *
 * @example
 * const opengateway = createOpenGateway();
 * await streamText({ model: opengateway('openai/gpt-4o-mini'), prompt: '...' });
 */
export function createOpenGateway(
  settings: CreateOpenGatewaySettings = {}
): (modelId: string) => LanguageModelV4 {
  const { apiKey, baseURL, metadataExtractor, ...rest } = settings;
  const provider = createOpenAICompatible({
    ...rest,
    name: "opengateway",
    baseURL: baseURL ?? DEFAULT_BASE_URL,
    apiKey: apiKey ?? process.env.OPENGATEWAY_API_KEY,
    metadataExtractor: createOpenGatewayMetadataExtractor(metadataExtractor),
  });
  return (modelId: string) =>
    wrapLanguageModel({
      model: provider(modelId),
      middleware: opengatewayReasoningRoundtripMiddleware,
    });
}
