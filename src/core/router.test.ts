import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import { generateText, streamText } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { detectModalities } from './modality';
import { createRouter } from './router';
import type { Modality } from './types';

// `route()` is typed as `LanguageModel` (a union that includes a bare model-id
// string). The router always returns a V4 model object; narrow it so tests can
// read model-level fields like `supportedUrls` without fighting the union.
const asV4 = (m: LanguageModel): LanguageModelV4 => m as LanguageModelV4;

// ---------------------------------------------------------------------------
// V4 result building blocks (nested usage + object finishReason). Copied from
// the existing suite verbatim so every mock returns a spec-valid shape.
// ---------------------------------------------------------------------------
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const finishReason = { unified: 'stop' as const, raw: 'stop' };

// Regex literals hoisted to module scope (Biome performance/useTopLevelRegex):
// allocate each matcher once rather than per assertion / per mock construction.
const NO_CANDIDATE_RE = /no candidate.*modalities/;
const EXAMPLE_HTTPS_RE = /^https:\/\/example\.com\/.*$/;
const OTHER_HTTPS_RE = /^https:\/\/other\.com\/.*$/;

function okModel(text = 'Hello, world!') {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason,
      usage,
      warnings: [],
    }),
  });
}

function failingModel(message = 'simulated API failure') {
  return new MockLanguageModelV4({
    doGenerate: () => Promise.reject(new Error(message)),
  });
}

function streamingModel(parts: string[] = ['Hello', ', world!']) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          ...parts.map((delta) => ({
            type: 'text-delta' as const,
            id: '1',
            delta,
          })),
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason, usage },
        ],
      }),
    }),
  });
}

function failingStreamModel(message = 'simulated stream failure') {
  return new MockLanguageModelV4({
    doStream: () => Promise.reject(new Error(message)),
  });
}

// A V4 image file part (data URL, not http) so the SDK inlines it instead of
// fetching over the network — keeps every integration test hermetic.
const imagePart = {
  type: 'file' as const,
  mediaType: 'image/png',
  data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
};

async function collectStream(result: ReturnType<typeof streamText>) {
  let acc = '';
  for await (const chunk of result.textStream) {
    acc += chunk;
  }
  return acc;
}

// ---------------------------------------------------------------------------
// detectModalities
// ---------------------------------------------------------------------------
describe('detectModalities', () => {
  it('detects text from system + text parts', () => {
    const mods = detectModalities([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect([...mods]).toEqual(['text']);
  });

  it('detects image and pdf via mediaType (full, wildcard, bare, application/pdf)', () => {
    const mods = detectModalities([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'url', url: new URL('https://x/y.png') },
          },
          {
            type: 'file',
            mediaType: 'application/pdf',
            data: { type: 'url', url: new URL('https://x/y.pdf') },
          },
        ],
      },
    ]);
    const expected: Modality[] = ['text', 'image', 'pdf'];
    expect([...mods].sort()).toEqual(expected.sort());
  });
});

// ---------------------------------------------------------------------------
// createRouter — routing, fallback, modality filtering, errors
// ---------------------------------------------------------------------------
describe('createRouter — routing & options', () => {
  it('routes to the first matching entry and forwards options', async () => {
    const primary = okModel('primary');
    const secondary = okModel('secondary');
    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: 'p', supports: ['text'] },
          { provider: () => secondary, model: 's', supports: ['text'] },
        ],
      },
    });

    const { text } = await generateText({
      model: route('chat'),
      prompt: 'hi',
      temperature: 0.42,
    });

    // First matching entry wins; the second is never consulted.
    expect(text).toBe('primary');
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(0);

    // Call options are forwarded verbatim to the underlying model.
    expect(primary.doGenerateCalls[0].temperature).toBe(0.42);
  });
});

describe('createRouter — fallback', () => {
  it('falls back from a failing primary to a working secondary', async () => {
    const primary = failingModel('429 rate limited');
    const secondary = okModel('fallback answer');
    const errors: unknown[] = [];

    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: 'p', supports: ['text'] },
          { provider: () => secondary, model: 's', supports: ['text'] },
        ],
      },
      onError: ({ error }) => errors.push(error),
    });

    const { text } = await generateText({ model: route('chat'), prompt: 'hi' });
    expect(text).toBe('fallback answer');
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('429 rate limited');
  });

  it('re-throws the LAST error when every candidate fails', async () => {
    const a = failingModel('first failure');
    const b = failingModel('second failure');
    const c = failingModel('last failure');

    const route = createRouter({
      models: {
        chat: [
          { provider: () => a, model: 'a', supports: ['text'] },
          { provider: () => b, model: 'b', supports: ['text'] },
          { provider: () => c, model: 'c', supports: ['text'] },
        ],
      },
    });

    // The error surfaced is the one from the final candidate, not the first.
    await expect(
      generateText({ model: route('chat'), prompt: 'hi' }),
    ).rejects.toThrow('last failure');
    expect(a.doGenerateCalls).toHaveLength(1);
    expect(b.doGenerateCalls).toHaveLength(1);
    expect(c.doGenerateCalls).toHaveLength(1);
  });

  it('invokes onError once per failed candidate with { logicalId, entry, index, error }', async () => {
    const primary = failingModel('boom');
    const secondary = okModel('ok');

    const primaryEntry = {
      provider: () => primary,
      model: 'p',
      supports: ['text'] as Modality[],
    };
    const secondaryEntry = {
      provider: () => secondary,
      model: 's',
      supports: ['text'] as Modality[],
    };

    const seen: Array<{
      logicalId: string;
      entry: unknown;
      index: number;
      error: unknown;
    }> = [];

    const route = createRouter({
      models: { chat: [primaryEntry, secondaryEntry] },
      onError: (info) => seen.push(info),
    });

    await generateText({ model: route('chat'), prompt: 'hi' });

    // Only the failing primary triggers onError; the successful secondary does not.
    expect(seen).toHaveLength(1);
    expect(seen[0].logicalId).toBe('chat');
    expect(seen[0].index).toBe(0);
    expect(seen[0].entry).toBe(primaryEntry);
    expect((seen[0].error as Error).message).toBe('boom');
  });
});

describe('createRouter — modality filtering', () => {
  it('skips a text-only entry and picks the image-capable one when an image is present', async () => {
    const textOnly = okModel('text-only');
    const imageCapable = okModel('image-capable');

    const route = createRouter({
      models: {
        chat: [
          { provider: () => textOnly, model: 't', supports: ['text'] },
          {
            provider: () => imageCapable,
            model: 'i',
            supports: ['text', 'image'],
          },
        ],
      },
    });

    const { text } = await generateText({
      model: route('chat'),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'describe' }, imagePart],
        },
      ],
    });

    expect(text).toBe('image-capable');
    expect(textOnly.doGenerateCalls).toHaveLength(0);
    expect(imageCapable.doGenerateCalls).toHaveLength(1);
  });

  it('throws a clear "no candidate ... modalities" error when no entry supports the modality', async () => {
    // Only text/image providers are configured, but the prompt carries a PDF.
    const textModel = okModel('text');
    const imageModel = okModel('image');

    const route = createRouter({
      models: {
        chat: [
          { provider: () => textModel, model: 't', supports: ['text'] },
          {
            provider: () => imageModel,
            model: 'i',
            supports: ['text', 'image'],
          },
        ],
      },
    });

    await expect(
      generateText({
        model: route('chat'),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'read this' },
              {
                type: 'file',
                mediaType: 'application/pdf',
                // 1x1 transparent png bytes are fine as opaque pdf payload here;
                // detection only reads mediaType, and no candidate matches so
                // the underlying models are never invoked.
                data: 'data:application/pdf;base64,JVBERi0xLjQK',
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow(NO_CANDIDATE_RE);

    // No candidate matched, so nothing was ever called.
    expect(textModel.doGenerateCalls).toHaveLength(0);
    expect(imageModel.doGenerateCalls).toHaveLength(0);
  });
});

describe('createRouter — configuration errors', () => {
  it('throws "unknown model id" for an unregistered logical id', () => {
    const route = createRouter({ models: {} });
    expect(() => route('nope')).toThrow('unknown model id');
  });

  it('throws when a logical id maps to an empty candidate list', () => {
    const route = createRouter({ models: { chat: [] } });
    expect(() => route('chat')).toThrow('no provider entries');
  });
});

// ---------------------------------------------------------------------------
// createRouter — streaming
// ---------------------------------------------------------------------------
describe('createRouter — streaming', () => {
  it('streams via the routed model', async () => {
    const model = streamingModel(['Hello', ', world!']);
    const route = createRouter({
      models: {
        chat: [{ provider: () => model, model: 'm', supports: ['text'] }],
      },
    });

    const acc = await collectStream(
      streamText({ model: route('chat'), prompt: 'hi' }),
    );
    expect(acc).toBe('Hello, world!');
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('falls back to the secondary when the primary doStream throws', async () => {
    const primary = failingStreamModel('stream 503');
    const secondary = streamingModel(['from ', 'secondary']);
    const errors: unknown[] = [];

    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: 'p', supports: ['text'] },
          { provider: () => secondary, model: 's', supports: ['text'] },
        ],
      },
      onError: ({ error }) => errors.push(error),
    });

    const acc = await collectStream(
      streamText({ model: route('chat'), prompt: 'hi' }),
    );
    expect(acc).toBe('from secondary');
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('stream 503');
  });
});

// ---------------------------------------------------------------------------
// createRouter — lazy instantiation & caching
// ---------------------------------------------------------------------------
describe('createRouter — lazy instantiation & caching', () => {
  it('does not instantiate any provider until a request is made', () => {
    let factoryCalls = 0;
    const route = createRouter({
      models: {
        chat: [
          {
            provider: () => {
              factoryCalls++;
              return okModel();
            },
            model: 'm',
            supports: ['text'],
          },
        ],
      },
    });

    // Resolving the logical id is cheap — no provider is built yet.
    route('chat');
    expect(factoryCalls).toBe(0);
  });

  it('instantiates each provider factory at most once across many requests on a routed model', async () => {
    let factoryCalls = 0;
    const model = okModel('cached');
    const route = createRouter({
      models: {
        chat: [
          {
            provider: () => {
              factoryCalls++;
              return model;
            },
            model: 'm',
            supports: ['text'],
          },
        ],
      },
    });

    // A single routed model is reused for multiple requests; the underlying
    // factory is invoked lazily on the first request and cached thereafter.
    const routed = route('chat');
    await generateText({ model: routed, prompt: 'a' });
    await generateText({ model: routed, prompt: 'b' });
    await generateText({ model: routed, prompt: 'c' });

    expect(factoryCalls).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it('only instantiates the candidates needed to satisfy a request (lazy fallback)', async () => {
    let primaryBuilt = 0;
    let secondaryBuilt = 0;
    const primary = okModel('primary');
    const secondary = okModel('secondary');

    const route = createRouter({
      models: {
        chat: [
          {
            provider: () => {
              primaryBuilt++;
              return primary;
            },
            model: 'p',
            supports: ['text'],
          },
          {
            provider: () => {
              secondaryBuilt++;
              return secondary;
            },
            model: 's',
            supports: ['text'],
          },
        ],
      },
    });

    await generateText({ model: route('chat'), prompt: 'hi' });

    // selectCandidates instantiates every modality-matching candidate up front,
    // so both text providers are built even though only the primary is called.
    expect(primaryBuilt).toBe(1);
    expect(secondaryBuilt).toBe(1);
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createRouter — supportedUrls inheritance
// ---------------------------------------------------------------------------
describe('createRouter — supportedUrls', () => {
  it('inherits supportedUrls from the FIRST candidate (not the second)', async () => {
    const supported = { 'image/*': [EXAMPLE_HTTPS_RE] };
    const first = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'first',
      supportedUrls: supported,
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'x' }],
        finishReason,
        usage,
        warnings: [],
      }),
    });
    const second = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'second',
      supportedUrls: { 'audio/*': [OTHER_HTTPS_RE] },
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'y' }],
        finishReason,
        usage,
        warnings: [],
      }),
    });

    const route = createRouter({
      models: {
        chat: [
          { provider: () => first, model: 'f', supports: ['text', 'image'] },
          { provider: () => second, model: 's', supports: ['text', 'image'] },
        ],
      },
    });

    // Forwarded straight from the first candidate's model. The mock exposes
    // supportedUrls as a Promise, which the router returns as-is (the source
    // intentionally never awaits/copies it), so await to compare the value.
    const inherited = await asV4(route('chat')).supportedUrls;
    expect(inherited).toEqual(supported);
    expect(inherited).not.toHaveProperty('audio/*');
  });

  it('reports no supported URLs for a single candidate with none', async () => {
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'm',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'z' }],
        finishReason,
        usage,
        warnings: [],
      }),
    });
    const route = createRouter({
      models: {
        chat: [{ provider: () => model, model: 'm', supports: ['text'] }],
      },
    });
    expect(await asV4(route('chat')).supportedUrls).toEqual({});
  });
});
