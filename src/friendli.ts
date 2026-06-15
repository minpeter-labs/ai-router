import type { LanguageModelV4 } from '@ai-sdk/provider';
import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from '@ai-sdk/openai-compatible';
import { wrapLanguageModel } from 'ai';

import { reasoningMiddleware, translateReasoning } from './reasoning';

const DEFAULT_BASE_URL = 'https://api.friendli.ai/serverless/v1';

export interface CreateFriendliSettings
  extends Omit<
    OpenAICompatibleProviderSettings,
    'name' | 'baseURL' | 'transformRequestBody'
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
  settings: CreateFriendliSettings = {},
): (modelId: string) => LanguageModelV4 {
  const { apiKey, baseURL, ...rest } = settings;
  const provider = createOpenAICompatible({
    ...rest,
    name: 'friendli',
    baseURL: baseURL ?? DEFAULT_BASE_URL,
    apiKey: apiKey ?? process.env.FRIENDLI_TOKEN,
    transformRequestBody: translateReasoning('friendli'),
  });
  // Wrap each model so a top-level `reasoning: 'none'` survives down to the body
  // (the AI SDK otherwise drops it before `transformRequestBody` can see it).
  return (modelId: string) =>
    wrapLanguageModel({
      model: provider(modelId),
      middleware: reasoningMiddleware('friendli'),
    });
}
