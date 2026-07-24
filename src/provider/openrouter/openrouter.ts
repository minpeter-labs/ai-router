import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";

import {
  prepareProviderSettings,
  rejectAsyncProviderSettingValues,
  snapshotProviderHeaders,
  snapshotProviderQueryParams,
  validateCommonProviderSettings,
} from "../provider-settings";
import {
  captureProviderConvertUsage,
  captureProviderFetch,
} from "../provider-settings-fetch";
import {
  captureProviderMetadataExtractor,
  captureProviderModelId,
} from "../provider-settings-metadata";
import { captureProviderSupportedUrls } from "../provider-settings-urls";
import {
  openrouterReasoningMiddleware,
  openrouterReasoningTransform,
} from "./reasoning";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export interface CreateOpenRouterSettings
  extends Omit<
    OpenAICompatibleProviderSettings,
    "name" | "baseURL" | "transformRequestBody"
  > {
  /** OpenRouter API key. Defaults to `process.env.OPENROUTER_API_KEY`. */
  apiKey?: string;
  /** Override the base URL. Defaults to the OpenRouter v1 endpoint. */
  baseURL?: string;
}

/**
 * OpenRouter provider built on `@ai-sdk/openai-compatible`.
 *
 * The `reasoning` option drives OpenRouter's `reasoning.enabled` (boolean) for
 * every level, on or off:
 *  - `reasoning: 'low' | 'medium' | 'high' | …` -> `reasoning.enabled: true`
 *  - `reasoning: 'none'`                         -> `reasoning.enabled: false`
 *
 * @example
 * const openrouter = createOpenRouter();
 * await streamText({ model: openrouter('moonshotai/kimi-k2.5'), reasoning: 'high', prompt: '...' });
 */
export function createOpenRouter(
  settings: CreateOpenRouterSettings = {}
): (modelId: string) => LanguageModelV4 {
  prepareProviderSettings(settings, "OpenRouter");
  const captured = {
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    convertUsage: settings.convertUsage,
    fetch: settings.fetch,
    headers: settings.headers,
    includeUsage: settings.includeUsage,
    metadataExtractor: settings.metadataExtractor,
    queryParams: settings.queryParams,
    supportedUrls: settings.supportedUrls,
    supportsStructuredOutputs: settings.supportsStructuredOutputs,
  };
  rejectAsyncProviderSettingValues(Object.values(captured), "OpenRouter");
  validateCommonProviderSettings(captured, "OpenRouter");
  const metadataExtractor = captureProviderMetadataExtractor(
    captured.metadataExtractor,
    "OpenRouter"
  );
  const convertUsage = captureProviderConvertUsage(
    captured.convertUsage,
    "OpenRouter",
    settings
  );
  const fetch = captureProviderFetch(captured.fetch, "OpenRouter", settings);
  const headers = snapshotProviderHeaders(captured.headers, "OpenRouter");
  const queryParams = snapshotProviderQueryParams(
    captured.queryParams,
    "OpenRouter"
  );
  const supportedUrls = captureProviderSupportedUrls(
    captured.supportedUrls,
    "OpenRouter",
    settings
  );
  const provider = createOpenAICompatible({
    convertUsage,
    fetch,
    headers,
    includeUsage: captured.includeUsage,
    metadataExtractor,
    queryParams,
    supportedUrls,
    supportsStructuredOutputs: captured.supportsStructuredOutputs,
    name: "openrouter",
    baseURL: captured.baseURL ?? DEFAULT_BASE_URL,
    apiKey: captured.apiKey ?? process.env.OPENROUTER_API_KEY,
    transformRequestBody: openrouterReasoningTransform,
  });
  // Wrap each model so a top-level `reasoning: 'none'` survives down to the body
  // (the AI SDK otherwise drops it before `transformRequestBody` can see it).
  return (modelId: string) =>
    wrapLanguageModel({
      model: provider(captureProviderModelId(modelId, "OpenRouter")),
      middleware: openrouterReasoningMiddleware,
    });
}
