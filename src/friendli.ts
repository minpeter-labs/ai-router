import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from '@ai-sdk/openai-compatible';

import { translateReasoning } from './reasoning';

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
 * It translates the AI SDK's `reasoning_effort` into Friendli's
 * `chat_template_kwargs.thinking` (boolean) and strips the foreign field.
 *
 * @example
 * const friendli = createFriendli();
 * await streamText({ model: friendli('K2-Instruct'), reasoning: 'high', prompt: '...' });
 */
export function createFriendli(settings: CreateFriendliSettings = {}) {
  const { apiKey, baseURL, ...rest } = settings;
  return createOpenAICompatible({
    ...rest,
    name: 'friendli',
    baseURL: baseURL ?? DEFAULT_BASE_URL,
    apiKey: apiKey ?? process.env.FRIENDLI_TOKEN,
    transformRequestBody: translateReasoning('friendli'),
  });
}
