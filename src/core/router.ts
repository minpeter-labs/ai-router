import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';

import { detectModalities, supportsAll } from './modality';
import type {
  CreateRouterOptions,
  OnRouterError,
  ProviderEntry,
} from './types';

/**
 * Resolved candidate: a provider entry plus its lazily-instantiated model.
 * Models are V4 language models (the `ai` `LanguageModel` union resolves to
 * `LanguageModelV4` for these openai-compatible backends).
 */
interface ResolvedEntry {
  entry: ProviderEntry;
  model: LanguageModelV4;
}

/**
 * A delegating `LanguageModelV4` for one logical id.
 *
 * For every request it:
 *  1. Detects the input modalities from the prompt.
 *  2. Keeps the candidate entries whose `supports` covers them, in order.
 *  3. Tries each candidate; on a thrown error it calls `onError` and falls
 *     through to the next one.
 *  4. Throws if no candidate matches the modalities, or all matching
 *     candidates fail (the last error is re-thrown).
 *
 * It forwards the call `options` verbatim — all candidates are V4 models with
 * identical option/result shapes, so no transformation is needed.
 */
class RouterLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'router';
  readonly modelId: string;

  private readonly entries: ProviderEntry[];
  private readonly onError?: OnRouterError;

  /** Cache of instantiated models, keyed by candidate index. */
  private readonly modelCache = new Map<number, LanguageModelV4>();

  constructor(
    logicalId: string,
    entries: ProviderEntry[],
    onError?: OnRouterError,
  ) {
    this.modelId = logicalId;
    this.entries = entries;
    this.onError = onError;
  }

  /**
   * Inherit `supportedUrls` from the first candidate's model. It may be a plain
   * object or a Promise; never copy/await it eagerly. If there are no
   * candidates we report "no supported URLs".
   */
  get supportedUrls(): LanguageModelV4['supportedUrls'] {
    if (this.entries.length === 0) return {};
    return this.instantiate(0).supportedUrls;
  }

  async doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    const candidates = this.selectCandidates(options);
    return this.run(candidates, (model) => model.doGenerate(options));
  }

  async doStream(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    const candidates = this.selectCandidates(options);
    return this.run(candidates, (model) => model.doStream(options));
  }

  /** Lazily instantiate (and cache) the model for a candidate index. */
  private instantiate(index: number): LanguageModelV4 {
    // Presence check (not truthiness) so a falsy model could never be re-created.
    if (this.modelCache.has(index)) {
      // biome-ignore lint/style/noNonNullAssertion: presence guaranteed by has() above
      return this.modelCache.get(index)!;
    }

    const entry = this.entries[index];
    const model = entry.provider(entry.model);
    // Fail fast — outside the fallback loop — if a factory returned something
    // that is not a v4 language model (a bare model-id string, or an older
    // spec). Otherwise it would crash deep inside the routed call and be
    // swallowed into fallback as an opaque error. The literal `'v4'` check also
    // narrows the `LanguageModel` union down to `LanguageModelV4`.
    if (typeof model !== 'object' || model.specificationVersion !== 'v4') {
      throw new Error(
        `ai-router: provider for "${this.modelId}" (model "${entry.model}") did not return a v4 LanguageModel`,
      );
    }
    this.modelCache.set(index, model);
    return model;
  }

  /** Filter entries by the prompt's required modalities, preserving order. */
  private selectCandidates(
    options: LanguageModelV4CallOptions,
  ): ResolvedEntry[] {
    const required = detectModalities(options.prompt);
    const resolved: ResolvedEntry[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (supportsAll(entry.supports, required)) {
        resolved.push({ entry, model: this.instantiate(i) });
      }
    }
    return resolved;
  }

  /** Try each candidate in order; fall back on error, re-throw the last one. */
  private async run<T>(
    candidates: ResolvedEntry[],
    call: (model: LanguageModelV4) => PromiseLike<T>,
  ): Promise<T> {
    if (candidates.length === 0) {
      throw new Error(
        `ai-router: no candidate for "${this.modelId}" supports the requested input modalities`,
      );
    }

    let lastError: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const { entry, model } = candidates[i];
      try {
        return await call(model);
      } catch (error) {
        lastError = error;
        this.onError?.({ logicalId: this.modelId, entry, index: i, error });
      }
    }

    throw lastError;
  }
}

/**
 * Create a modality-aware router with provider fallback.
 *
 * @returns a function `(logicalId) => LanguageModel` that resolves to a
 *   delegating language model accepted directly by `generateText`/`streamText`.
 *
 * @example
 * const route = createRouter({
 *   models: {
 *     chat: [
 *       { provider: createFriendli(),   model: 'K2-Instruct', supports: ['text'] },
 *       { provider: createOpenRouter(), model: 'moonshotai/kimi-k2', supports: ['text', 'image'] },
 *     ],
 *   },
 *   onError: ({ logicalId, error }) => console.warn(logicalId, error),
 * });
 *
 * await streamText({ model: route('chat'), prompt: 'hello' });
 */
export function createRouter(
  options: CreateRouterOptions,
): (logicalId: string) => LanguageModel {
  const { models, onError } = options;

  return (logicalId: string): LanguageModel => {
    const entries = models[logicalId];
    if (!entries) {
      throw new Error(`ai-router: unknown model id "${logicalId}"`);
    }
    if (entries.length === 0) {
      throw new Error(
        `ai-router: model id "${logicalId}" has no provider entries`,
      );
    }
    return new RouterLanguageModel(logicalId, entries, onError);
  };
}
