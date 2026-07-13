import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";

import {
  captureProviderConvertUsage,
  captureProviderFetch,
  captureProviderModelId,
  captureProviderSupportedUrls,
  prepareProviderSettings,
  rejectAsyncProviderSettingValues,
  snapshotProviderHeaders,
  snapshotProviderQueryParams,
  validateCommonProviderSettings,
} from "../provider-settings";
import { createOpenGatewayMetadataExtractor } from "./metadata";
import { createOpenGatewayReasoningRoundtripMiddleware } from "./reasoning-roundtrip";
import {
  createOpenGatewayReasoningDetailsStore,
  type OpenGatewayReasoningDetailsStore,
} from "./reasoning-roundtrip-store";

export type { OpenGatewayReasoningDetailsStore } from "./reasoning-roundtrip-store";

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
  reasoningDetailsRefMaxEntries?: number;
  reasoningDetailsRefTtlMs?: number;
  reasoningDetailsStore?: OpenGatewayReasoningDetailsStore;
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
  prepareProviderSettings(settings, "OpenGateway", [
    "reasoningDetailsRefMaxEntries",
    "reasoningDetailsRefTtlMs",
    "reasoningDetailsStore",
  ]);
  const captured = {
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    convertUsage: settings.convertUsage,
    fetch: settings.fetch,
    headers: settings.headers,
    includeUsage: settings.includeUsage,
    metadataExtractor: settings.metadataExtractor,
    queryParams: settings.queryParams,
    reasoningDetailsRefMaxEntries: settings.reasoningDetailsRefMaxEntries,
    reasoningDetailsRefTtlMs: settings.reasoningDetailsRefTtlMs,
    reasoningDetailsStore: settings.reasoningDetailsStore,
    supportedUrls: settings.supportedUrls,
    supportsStructuredOutputs: settings.supportsStructuredOutputs,
  };
  rejectAsyncProviderSettingValues(Object.values(captured), "OpenGateway");
  validateCommonProviderSettings(captured, "OpenGateway");
  const convertUsage = captureProviderConvertUsage(
    captured.convertUsage,
    "OpenGateway",
    settings
  );
  const fetch = captureProviderFetch(captured.fetch, "OpenGateway", settings);
  const headers = snapshotProviderHeaders(captured.headers, "OpenGateway");
  const queryParams = snapshotProviderQueryParams(
    captured.queryParams,
    "OpenGateway"
  );
  const supportedUrls = captureProviderSupportedUrls(
    captured.supportedUrls,
    "OpenGateway",
    settings
  );
  const provider = createOpenAICompatible({
    convertUsage,
    fetch,
    headers,
    includeUsage: captured.includeUsage,
    queryParams,
    supportedUrls,
    supportsStructuredOutputs: captured.supportsStructuredOutputs,
    name: "opengateway",
    baseURL: captured.baseURL ?? DEFAULT_BASE_URL,
    apiKey: captured.apiKey ?? process.env.OPENGATEWAY_API_KEY,
    metadataExtractor: createOpenGatewayMetadataExtractor(
      captured.metadataExtractor
    ),
  });
  const resolvedReasoningDetailsStore =
    captured.reasoningDetailsStore ??
    createOpenGatewayReasoningDetailsStore({
      maxEntries: captured.reasoningDetailsRefMaxEntries,
      ttlMs: captured.reasoningDetailsRefTtlMs,
    });
  const reasoningRoundtripMiddleware =
    createOpenGatewayReasoningRoundtripMiddleware({
      reasoningDetailsStore: resolvedReasoningDetailsStore,
    });
  return (modelId: string) =>
    wrapLanguageModel({
      model: provider(captureProviderModelId(modelId, "OpenGateway")),
      middleware: reasoningRoundtripMiddleware,
    });
}
