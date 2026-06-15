import { describe, it, expect } from 'vitest';
import { generateText } from 'ai';

import { createOpenRouter } from './openrouter';
import { captureFetch } from '../test-utils';

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
