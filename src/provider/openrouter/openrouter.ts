import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';

import { reasoningMiddleware, translateReasoning } from '../../core/reasoning';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface CreateOpenRouterSettings
  extends Omit<
    OpenAICompatibleProviderSettings,
    'name' | 'baseURL' | 'transformRequestBody'
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
  settings: CreateOpenRouterSettings = {},
): (modelId: string) => LanguageModelV4 {
  const { apiKey, baseURL, ...rest } = settings;
  const provider = createOpenAICompatible({
    ...rest,
    name: 'openrouter',
    baseURL: baseURL ?? DEFAULT_BASE_URL,
    apiKey: apiKey ?? process.env.OPENROUTER_API_KEY,
    transformRequestBody: translateReasoning('openrouter'),
  });
  // Wrap each model so a top-level `reasoning: 'none'` survives down to the body
  // (the AI SDK otherwise drops it before `transformRequestBody` can see it).
  return (modelId: string) =>
    wrapLanguageModel({
      model: provider(modelId),
      middleware: reasoningMiddleware('openrouter'),
    });
}
