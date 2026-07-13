import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";

import {
  captureProviderConvertUsage,
  captureProviderFetch,
  captureProviderMetadataExtractor,
  captureProviderModelId,
  captureProviderSupportedUrls,
  prepareProviderSettings,
  rejectAsyncProviderSettingValues,
  snapshotProviderHeaders,
  snapshotProviderQueryParams,
  validateCommonProviderSettings,
} from "../provider-settings";
import {
  friendliReasoningMiddleware,
  friendliReasoningTransform,
} from "./reasoning";

const DEFAULT_BASE_URL = "https://api.friendli.ai/serverless/v1";

export interface CreateFriendliSettings
  extends Omit<
    OpenAICompatibleProviderSettings,
    "name" | "baseURL" | "transformRequestBody"
  > {
  /** Friendli API token. Defaults to `process.env.FRIENDLI_TOKEN`. */
  apiKey?: string;
  /** Override the base URL. Defaults to the Friendli serverless endpoint. */
  baseURL?: string;
}

/**
 * Friendli provider built on `@ai-sdk/openai-compatible`.
 *
 * The `reasoning` option drives Friendli's `chat_template_kwargs.thinking`
 * (boolean) for every level, on or off:
 *  - `reasoning: 'low' | 'medium' | 'high' | …` -> `thinking: true`
 *  - `reasoning: 'none'`                         -> `thinking: false`
 *
 * @example
 * const friendli = createFriendli();
 * await streamText({ model: friendli('moonshotai/Kimi-K2.5'), reasoning: 'high', prompt: '...' });
 */
export function createFriendli(
  settings: CreateFriendliSettings = {}
): (modelId: string) => LanguageModelV4 {
  prepareProviderSettings(settings, "Friendli");
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
  rejectAsyncProviderSettingValues(Object.values(captured), "Friendli");
  validateCommonProviderSettings(captured, "Friendli");
  const metadataExtractor = captureProviderMetadataExtractor(
    captured.metadataExtractor,
    "Friendli"
  );
  const convertUsage = captureProviderConvertUsage(
    captured.convertUsage,
    "Friendli",
    settings
  );
  const fetch = captureProviderFetch(captured.fetch, "Friendli", settings);
  const headers = snapshotProviderHeaders(captured.headers, "Friendli");
  const queryParams = snapshotProviderQueryParams(
    captured.queryParams,
    "Friendli"
  );
  const supportedUrls = captureProviderSupportedUrls(
    captured.supportedUrls,
    "Friendli",
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
    name: "friendli",
    baseURL: captured.baseURL ?? DEFAULT_BASE_URL,
    apiKey: captured.apiKey ?? process.env.FRIENDLI_TOKEN,
    transformRequestBody: friendliReasoningTransform,
  });
  // Wrap each model so a top-level `reasoning: 'none'` survives down to the body
  // (the AI SDK otherwise drops it before `transformRequestBody` can see it).
  return (modelId: string) =>
    wrapLanguageModel({
      model: provider(captureProviderModelId(modelId, "Friendli")),
      middleware: friendliReasoningMiddleware,
    });
}
