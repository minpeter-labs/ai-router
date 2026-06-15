import { describe, it, expect } from 'vitest';
import { generateText } from 'ai';

import { createFriendli } from './friendli';
import { createOpenRouter } from './openrouter';

// A minimal-but-valid OpenAI chat.completion JSON response. The openai-compatible
// provider parses this into a generateText result. Returning a fresh Response per
// call keeps the body stream unconsumed across requests.
function chatCompletionResponse() {
  return new Response(
    JSON.stringify({
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'm',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

// Builds a fake `fetch` that records the outgoing request (url, headers, parsed
// JSON body) and always answers with a valid chat.completion. No network is hit.
function captureFetch() {
  const captured: { url?: string; headers: Headers; body?: any } = {
    headers: new Headers(),
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    captured.url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    captured.headers = new Headers(init?.headers as HeadersInit);
    if (typeof init?.body === 'string') captured.body = JSON.parse(init.body);
    return chatCompletionResponse();
  };
  return { fetch, captured };
}

describe('createFriendli', () => {
  it('returns a callable provider that builds a language model object', () => {
    const friendli = createFriendli({ apiKey: 'k' });
    expect(typeof friendli).toBe('function');

    const model = friendli('m');
    expect(model.specificationVersion).toBe('v4');
    expect(typeof model.doGenerate).toBe('function');
    expect(typeof model.doStream).toBe('function');
    expect(model.modelId).toBe('m');
    expect(model.provider).toBe('friendli.chat');
  });

  it('uses the friendli serverless base URL by default', async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({ apiKey: 'k', fetch });

    await generateText({ model: friendli('m'), prompt: 'hi' });

    expect(captured.url).toBe(
      'https://api.friendli.ai/serverless/v1/chat/completions',
    );
  });

  it('respects a baseURL override', async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({
      apiKey: 'k',
      fetch,
      baseURL: 'https://example.test/v9',
    });

    await generateText({ model: friendli('m'), prompt: 'hi' });

    expect(captured.url).toBe('https://example.test/v9/chat/completions');
  });

  it('uses the apiKey from settings as a bearer token', async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({ apiKey: 'secret-token', fetch });

    await generateText({ model: friendli('m'), prompt: 'hi' });

    expect(captured.headers.get('authorization')).toBe('Bearer secret-token');
  });

  it('translates top-level reasoning into chat_template_kwargs.thinking and strips reasoning_effort', async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({ apiKey: 'k', fetch });

    await generateText({
      model: friendli('m'),
      prompt: 'hi',
      providerOptions: { friendli: { reasoningEffort: 'high' } },
    });

    expect(captured.body.chat_template_kwargs).toEqual({ thinking: true });
    expect(captured.body.reasoning_effort).toBeUndefined();
  });

  it("enables thinking from a plain top-level reasoning: 'high'", async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({ apiKey: 'k', fetch });

    await generateText({ model: friendli('m'), prompt: 'hi', reasoning: 'high' });

    expect(captured.body.chat_template_kwargs).toEqual({ thinking: true });
    expect(captured.body.reasoning_effort).toBeUndefined();
  });

  it("disables thinking from a plain top-level reasoning: 'none'", async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({ apiKey: 'k', fetch });

    await generateText({ model: friendli('m'), prompt: 'hi', reasoning: 'none' });

    expect(captured.body.chat_template_kwargs).toEqual({ thinking: false });
    expect(captured.body.reasoning_effort).toBeUndefined();
  });

  it('leaves reasoning fields off the body when no reasoning is requested', async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({ apiKey: 'k', fetch });

    await generateText({ model: friendli('m'), prompt: 'hi' });

    expect('chat_template_kwargs' in captured.body).toBe(false);
    expect(captured.body.reasoning_effort).toBeUndefined();
  });
});

describe('createOpenRouter', () => {
  it('returns a callable provider that builds a language model object', () => {
    const openrouter = createOpenRouter({ apiKey: 'k' });
    expect(typeof openrouter).toBe('function');

    const model = openrouter('m');
    expect(model.specificationVersion).toBe('v4');
    expect(typeof model.doGenerate).toBe('function');
    expect(typeof model.doStream).toBe('function');
    expect(model.modelId).toBe('m');
    expect(model.provider).toBe('openrouter.chat');
  });

  it('uses the openrouter v1 base URL by default', async () => {
    const { fetch, captured } = captureFetch();
    const openrouter = createOpenRouter({ apiKey: 'k', fetch });

    await generateText({ model: openrouter('m'), prompt: 'hi' });

    expect(captured.url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('respects a baseURL override', async () => {
    const { fetch, captured } = captureFetch();
    const openrouter = createOpenRouter({
      apiKey: 'k',
      fetch,
      baseURL: 'https://example.test/v9',
    });

    await generateText({ model: openrouter('m'), prompt: 'hi' });

    expect(captured.url).toBe('https://example.test/v9/chat/completions');
  });

  it('uses the apiKey from settings as a bearer token', async () => {
    const { fetch, captured } = captureFetch();
    const openrouter = createOpenRouter({ apiKey: 'secret-token', fetch });

    await generateText({ model: openrouter('m'), prompt: 'hi' });

    expect(captured.headers.get('authorization')).toBe('Bearer secret-token');
  });

  it('translates top-level reasoning into reasoning.enabled and strips reasoning_effort', async () => {
    const { fetch, captured } = captureFetch();
    const openrouter = createOpenRouter({ apiKey: 'k', fetch });

    await generateText({
      model: openrouter('m'),
      prompt: 'hi',
      reasoning: 'high',
    });

    expect(captured.body.reasoning).toEqual({ enabled: true });
    expect(captured.body.reasoning_effort).toBeUndefined();
  });

  it("disables reasoning from a plain top-level reasoning: 'none'", async () => {
    const { fetch, captured } = captureFetch();
    const openrouter = createOpenRouter({ apiKey: 'k', fetch });

    await generateText({ model: openrouter('m'), prompt: 'hi', reasoning: 'none' });

    expect(captured.body.reasoning).toEqual({ enabled: false });
    expect(captured.body.reasoning_effort).toBeUndefined();
  });
});
