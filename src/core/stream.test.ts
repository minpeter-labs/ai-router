import { describe, it, expect } from 'vitest';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

import { defaultShouldRetryThisError } from './retry';
import { wrapStreamResult, type ResolvedEntry } from './stream';
import type { OnRouterError } from './types';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const finishReason = { unified: 'stop' as const, raw: 'stop' };
const callOptions = { prompt: [], includeRawChunks: false } as unknown as LanguageModelV4CallOptions;

/** A model whose stream emits exactly the given parts (in-band, closes normally). */
function chunkModel(chunks: LanguageModelV4StreamPart[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock',
    doStream: async () => ({
      stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }),
    }),
  });
}

/** A normal text stream emitting `parts` as deltas. */
function textModel(parts: string[]): MockLanguageModelV4 {
  return chunkModel([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    ...parts.map((delta) => ({ type: 'text-delta' as const, id: '1', delta })),
    { type: 'text-end', id: '1' },
    { type: 'finish', finishReason, usage },
  ]);
}

/** Emits stream-start, then optional text deltas, then an in-band error part. */
function errorPartModel(error: unknown, beforeText: string[] = []): MockLanguageModelV4 {
  const head: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
  if (beforeText.length > 0) {
    head.push({ type: 'text-start', id: '1' });
    for (const delta of beforeText) head.push({ type: 'text-delta', id: '1', delta });
  }
  head.push({ type: 'error', error });
  return chunkModel(head);
}

/** A model whose stream rejects on the next read after stream-start (transport drop). */
function transportRejectModel(error: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock',
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
        },
        pull() {
          throw error;
        },
      }),
    }),
  });
}

function resolved(model: LanguageModelV4, fullIndex = 0): ResolvedEntry {
  return { entry: model, model, fullIndex };
}

interface DriveResult {
  parts: LanguageModelV4StreamPart[];
  error: unknown;
  text: string;
}

async function drive(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<DriveResult> {
  const reader = stream.getReader();
  const parts: LanguageModelV4StreamPart[] = [];
  let error: unknown;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  } catch (e) {
    error = e;
  }
  const text = parts
    .filter((p): p is Extract<LanguageModelV4StreamPart, { type: 'text-delta' }> => p.type === 'text-delta')
    .map((p) => p.delta)
    .join('');
  return { parts, error, text };
}

async function runFallback(
  models: MockLanguageModelV4[],
  opts: { retryAfterOutput?: boolean; shouldRetry?: (e: unknown) => boolean; onError?: OnRouterError } = {},
): Promise<DriveResult> {
  const candidates = models.map((m, i) => resolved(m, i));
  const firstResult = await candidates[0].model.doStream(callOptions);
  const wrapped = wrapStreamResult({
    logicalId: 'chat',
    candidates,
    startIndex: 0,
    options: callOptions,
    firstResult,
    shouldRetry: opts.shouldRetry ?? defaultShouldRetryThisError,
    retryAfterOutput: opts.retryAfterOutput ?? false,
    onError: opts.onError,
  });
  return drive(wrapped.stream);
}

describe('createFallbackStream (mid-stream fallback)', () => {
  it('passes a clean single stream through unchanged', async () => {
    const out = await runFallback([textModel(['Hello', ', world!'])]);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe('Hello, world!');
  });

  it('falls back on a PRE-output in-band error part, swallowing the error', async () => {
    const primary = errorPartModel(new Error('overloaded 503'));
    const secondary = textModel(['from ', 'secondary']);
    const seen: Array<{ index: number; phase?: string; willRetry?: boolean }> = [];

    const out = await runFallback([primary, secondary], {
      onError: (info) => seen.push({ index: info.index, phase: info.phase, willRetry: info.willRetry }),
    });

    expect(out.text).toBe('from secondary');
    // The failed candidate's terminal error part was swallowed, not forwarded.
    expect(out.parts.some((p) => p.type === 'error')).toBe(false);
    expect(out.error).toBeUndefined();
    expect(seen).toEqual([{ index: 0, phase: 'stream-open', willRetry: true }]);
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(secondary.doStreamCalls).toHaveLength(1);
  });

  it('does NOT fall back after content streamed (retryAfterOutput=false) — no double-emit', async () => {
    const primary = errorPartModel(new Error('503'), ['partial answer']);
    const secondary = textModel(['SHOULD NOT APPEAR']);

    const out = await runFallback([primary, secondary], { retryAfterOutput: false });

    // 'partial answer' appears exactly once; the secondary is never consulted.
    expect(out.text).toBe('partial answer');
    expect(secondary.doStreamCalls).toHaveLength(0);
    // The terminal error part is forwarded verbatim (cannot un-ring the bell).
    expect(out.parts.some((p) => p.type === 'error')).toBe(true);
  });

  it('DOES fall back after content when retryAfterOutput=true (may duplicate)', async () => {
    const primary = errorPartModel(new Error('503'), ['partial ']);
    const secondary = textModel(['secondary']);

    const out = await runFallback([primary, secondary], { retryAfterOutput: true });

    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(out.text).toContain('partial ');
    expect(out.text).toContain('secondary');
  });

  it('treats a rejected read (transport drop) like an error and falls back', async () => {
    const primary = transportRejectModel(new Error('transport drop 503'));
    const secondary = textModel(['recovered']);

    const out = await runFallback([primary, secondary]);
    expect(out.text).toBe('recovered');
    expect(out.error).toBeUndefined();
  });

  it('does NOT fall back on a non-retryable pre-output error', async () => {
    const primary = errorPartModel({ statusCode: 400, message: 'bad request' });
    const secondary = textModel(['secondary']);

    const out = await runFallback([primary, secondary]);
    expect(secondary.doStreamCalls).toHaveLength(0);
    expect((out.error as { statusCode?: number }).statusCode).toBe(400);
  });

  it('surfaces an AggregateError when every candidate fails mid-stream', async () => {
    const a = errorPartModel(new Error('first 503'));
    const b = errorPartModel(new Error('second 503'));
    const c = errorPartModel(new Error('last 503'));

    const out = await runFallback([a, b, c]);
    expect(out.error).toBeInstanceOf(AggregateError);
    expect((out.error as AggregateError).errors).toHaveLength(3);
    expect((out.error as AggregateError).message).toContain('last 503');
  });

  it('falls back on a pre-content error that arrives AFTER framing parts (response-metadata/text-start)', async () => {
    // The openai-compatible provider emits response-metadata (and text-start) on
    // its first chunk before any text-delta. An error there is still pre-content.
    const primary = chunkModel([
      { type: 'stream-start', warnings: [] },
      { type: 'response-metadata', id: 'res-1', modelId: 'm', timestamp: new Date(0) },
      { type: 'text-start', id: '1' },
      { type: 'error', error: new Error('overloaded 503') },
    ]);
    const secondary = textModel(['from secondary']);

    const out = await runFallback([primary, secondary]);
    expect(out.text).toBe('from secondary');
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(out.parts.some((p) => p.type === 'error')).toBe(false);
  });

  it('emits exactly one stream-start after a pre-content fallback', async () => {
    const out = await runFallback([errorPartModel(new Error('503')), textModel(['ok'])]);
    expect(out.parts.filter((p) => p.type === 'stream-start')).toHaveLength(1);
  });

  it('reports phase stream-mid for a post-content failure when retryAfterOutput=true', async () => {
    const primary = errorPartModel(new Error('503'), ['partial ']);
    const secondary = textModel(['secondary']);
    const seen: Array<{ phase?: string; willRetry?: boolean }> = [];

    await runFallback([primary, secondary], {
      retryAfterOutput: true,
      onError: (info) => seen.push({ phase: info.phase, willRetry: info.willRetry }),
    });

    expect(seen).toContainEqual({ phase: 'stream-mid', willRetry: true });
  });
});
