import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from '@ai-sdk/openai-compatible';

import { translateReasoning } from './reasoning';

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
 * It translates the AI SDK's `reasoning_effort` into OpenRouter's
 * `reasoning.enabled` (boolean) and strips the foreign field.
 *
 * @example
 * const openrouter = createOpenRouter();
 * await streamText({ model: openrouter('moonshotai/kimi-k2'), reasoning: 'high', prompt: '...' });
 */
export function createOpenRouter(settings: CreateOpenRouterSettings = {}) {
  const { apiKey, baseURL, ...rest } = settings;
  return createOpenAICompatible({
    ...rest,
    name: 'openrouter',
    baseURL: baseURL ?? DEFAULT_BASE_URL,
    apiKey: apiKey ?? process.env.OPENROUTER_API_KEY,
    transformRequestBody: translateReasoning('openrouter'),
  });
}
