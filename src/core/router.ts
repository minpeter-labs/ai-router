import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

import { CooldownState, resolveCooldown } from "./cooldown";
import { detectModalities, supportsAll } from "./modality";
import { resolveShouldRetry, safeShouldRetry, surfaceFailure } from "./retry";
import { type ResolvedEntry, wrapStreamResult } from "./stream";
import type {
  CreateRouterOptions,
  Modality,
  OnRouterError,
  ProviderEntry,
  ProviderEntryFactory,
  ProviderEntryInstance,
  ShouldRetryThisError,
} from "./types";

/**
 * A candidate entry normalized to a single internal shape, regardless of which
 * of the three accepted `ProviderEntry` forms the user wrote.
 */
interface NormalizedEntry {
  /** Model id for the fail-fast error message (factory form only). */
  label?: string;
  /** The user's original entry — surfaced verbatim on `onError`. */
  original: ProviderEntry;
  /** Produce the raw model (calls the factory, or returns the captured instance). */
  raw: () => LanguageModel;
  /** Declared modalities, or `undefined` for a universal (catch-all) candidate. */
  supports?: Modality[];
}

/** Duck-type a value as a v4 `LanguageModel` (a bare instance candidate). */
function isLanguageModelV4(value: unknown): value is LanguageModelV4 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { specificationVersion?: unknown }).specificationVersion ===
      "v4" &&
    typeof (value as { doStream?: unknown }).doStream === "function"
  );
}

/** Collapse any of the three `ProviderEntry` shapes into a {@link NormalizedEntry}. */
function normalizeEntry(entry: ProviderEntry): NormalizedEntry {
  // (1) Bare instance shorthand: a v4 model object used directly as a candidate.
  if (isLanguageModelV4(entry)) {
    return { original: entry, raw: () => entry };
  }
  // (2) Instance-object form: `{ model: <v4 model>, supports? }`.
  const candidate = entry as ProviderEntryFactory | ProviderEntryInstance;
  if (candidate.model !== null && typeof candidate.model === "object") {
    const instance = candidate as ProviderEntryInstance;
    return {
      supports: instance.supports,
      original: entry,
      raw: () => instance.model,
    };
  }
  // (3) Factory form: `{ provider, model: string, supports? }`.
  const factory = candidate as ProviderEntryFactory;
  return {
    supports: factory.supports,
    original: entry,
    label: typeof factory.model === "string" ? factory.model : undefined,
    raw: () => {
      // Guard the (untyped JS) misuse where `model` is missing/not a string, so
      // it fails with a clear message instead of `provider(undefined)`.
      if (
        typeof factory.provider !== "function" ||
        typeof factory.model !== "string"
      ) {
        throw new Error(
          "ai-router: a factory entry requires a `provider` function and a string `model`"
        );
      }
      return factory.provider(factory.model);
    },
  };
}

/**
 * A delegating `LanguageModelV4` for one logical id.
 *
 * For every request it:
 *  1. Detects the input modalities from the prompt.
 *  2. Keeps the candidate entries whose `supports` covers them, in order.
 *  3. Tries each candidate; on failure it classifies the error (retry vs stop),
 *     calls `onError`, and falls through to the next one when retryable.
 *  4. On `doStream`, wraps the live stream so a mid-stream failure also falls
 *     back transparently (before any content has been emitted).
 *  5. Surfaces the original error for a single failure, or an `AggregateError`
 *     of all candidate errors when several fail.
 *
 * It forwards the call `options` verbatim — all candidates are V4 models with
 * identical option/result shapes, so no transformation is needed.
 */
class RouterLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "router";
  readonly modelId: string;

  private readonly normalized: NormalizedEntry[];
  private readonly onError?: OnRouterError;
  private readonly shouldRetry: ShouldRetryThisError;
  private readonly retryAfterOutput: boolean;
  private readonly cooldown?: CooldownState;

  /** Cache of instantiated models, keyed by candidate index. */
  private readonly modelCache = new Map<number, LanguageModelV4>();
  /** Memoized conservative `supportedUrls` (computed once per instance). */
  private supportedUrlsCache?: LanguageModelV4["supportedUrls"];

  constructor(
    logicalId: string,
    entries: ProviderEntry[],
    options: CreateRouterOptions
  ) {
    this.modelId = logicalId;
    this.normalized = entries.map(normalizeEntry);
    this.onError = options.onError;
    this.shouldRetry = resolveShouldRetry(options.shouldRetryThisError);
    this.retryAfterOutput = options.retryAfterOutput ?? false;
    const cfg = resolveCooldown(options.cooldown);
    this.cooldown = cfg ? new CooldownState(cfg) : undefined;
  }

  /**
   * The set of URLs the router can pass through un-downloaded. The AI SDK reads
   * this ONCE during call setup to decide whether to download+inline a URL or
   * forward it raw — but it cannot know which candidate will actually serve the
   * request. So we report only the support COMMON to every candidate: a URL is
   * passed through only if all candidates handle it natively; otherwise the SDK
   * inlines it (which any candidate accepts). Computed once and memoized.
   */
  get supportedUrls(): LanguageModelV4["supportedUrls"] {
    this.supportedUrlsCache ??= this.computeSupportedUrls();
    return this.supportedUrlsCache;
  }

  private computeSupportedUrls(): LanguageModelV4["supportedUrls"] {
    // With multiple candidates the router cannot know which one will serve the
    // request, so it conservatively reports NO native URL support — the SDK then
    // downloads + inlines every URL, which any candidate accepts. A lone
    // candidate can safely report its own support. Either way, a broken / non-v4
    // first entry must not abort call setup (read before any fallback runs).
    if (this.normalized.length !== 1) {
      return {};
    }
    try {
      return this.instantiate(0).supportedUrls;
    } catch {
      return {};
    }
  }

  async doGenerate(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4GenerateResult> {
    const { candidates, startIndex } = this.selectCandidates(options);
    this.assertHasCandidate(candidates);

    const errors: unknown[] = [];
    for (let k = startIndex; k < candidates.length; k++) {
      const candidate = candidates[k];
      try {
        const result = await candidate.model.doGenerate(options);
        this.commitSurvivor(candidate.fullIndex, errors.length > 0);
        return result;
      } catch (error) {
        if (
          !this.handleFailure(
            error,
            candidate,
            k,
            candidates,
            errors,
            "generate"
          )
        ) {
          break;
        }
      }
    }
    throw surfaceFailure(errors, this.modelId);
  }

  async doStream(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4StreamResult> {
    const { candidates, startIndex } = this.selectCandidates(options);
    this.assertHasCandidate(candidates);

    const onAdvance = this.cooldown
      ? (filteredIndex: number, hadFailure: boolean) =>
          this.commitSurvivor(candidates[filteredIndex].fullIndex, hadFailure)
      : undefined;

    const errors: unknown[] = [];
    for (let k = startIndex; k < candidates.length; k++) {
      const candidate = candidates[k];
      let result: LanguageModelV4StreamResult;
      try {
        // Errors thrown BEFORE the stream opens are caught here; errors that
        // arrive AFTER it opens are handled inside wrapStreamResult.
        result = await candidate.model.doStream(options);
      } catch (error) {
        if (
          !this.handleFailure(
            error,
            candidate,
            k,
            candidates,
            errors,
            "stream-open"
          )
        ) {
          break;
        }
        continue;
      }
      return wrapStreamResult({
        logicalId: this.modelId,
        candidates,
        startIndex: k,
        options,
        firstResult: result,
        shouldRetry: this.shouldRetry,
        retryAfterOutput: this.retryAfterOutput,
        onError: this.onError,
        onAdvance,
        priorErrors: errors,
      });
    }
    throw surfaceFailure(errors, this.modelId);
  }

  /**
   * Record the error, classify it, notify `onError`, and report whether the
   * router should keep trying the next candidate (`true`) or stop (`false`).
   */
  private handleFailure(
    error: unknown,
    candidate: ResolvedEntry,
    index: number,
    candidates: ResolvedEntry[],
    errors: unknown[],
    phase: "generate" | "stream-open"
  ): boolean {
    errors.push(error);
    const retry = safeShouldRetry(this.shouldRetry, error);
    const hasNext = retry && index + 1 < candidates.length;
    try {
      this.onError?.({
        logicalId: this.modelId,
        entry: candidate.entry,
        index,
        error,
        phase,
        willRetry: hasNext,
      });
    } catch {
      /* onError must not throw; ignore. */
    }
    return retry;
  }

  /**
   * Commit a survivor into cooldown state, but only when reaching it actually
   * involved an earlier candidate failing (`hadFailure`), or when it is the
   * primary recovering (`fullIndex === 0`). A candidate reached merely because
   * earlier entries were modality-filtered out must NOT become sticky —
   * otherwise a later request of a different modality would skip a perfectly
   * healthy higher-priority primary. No-op when cooldown is disabled.
   */
  private commitSurvivor(fullIndex: number, hadFailure: boolean): void {
    if (hadFailure || fullIndex === 0) {
      this.cooldown?.advanceTo(fullIndex);
    }
  }

  private assertHasCandidate(candidates: ResolvedEntry[]): void {
    if (candidates.length === 0) {
      throw new Error(
        `ai-router: no candidate for "${this.modelId}" supports the requested input modalities`
      );
    }
  }

  /** Lazily instantiate (and cache) the model for a candidate index. */
  private instantiate(index: number): LanguageModelV4 {
    // Cached models are always defined objects, so a present entry short-circuits
    // without a second Map lookup (and never re-creates a candidate).
    const cached = this.modelCache.get(index);
    if (cached !== undefined) {
      return cached;
    }

    const entry = this.normalized[index];
    const model = entry.raw();
    // Fail fast — outside the fallback loop — if a factory or instance entry did
    // not yield a v4 language model (a bare model-id string, or an older spec).
    // Otherwise it would crash deep inside the routed call and be swallowed into
    // fallback as an opaque error.
    if (!isLanguageModelV4(model)) {
      throw new Error(
        entry.label === undefined
          ? `ai-router: entry for "${this.modelId}" did not provide a v4 LanguageModel`
          : `ai-router: provider for "${this.modelId}" (model "${entry.label}") did not return a v4 LanguageModel`
      );
    }
    this.modelCache.set(index, model);
    return model;
  }

  /**
   * Filter entries by the prompt's required modalities (preserving order and
   * the full-array index), and compute the start position — candidate 0 by
   * default, or the sticky survivor when cooldown is enabled.
   */
  private selectCandidates(options: LanguageModelV4CallOptions): {
    candidates: ResolvedEntry[];
    startIndex: number;
  } {
    const required = detectModalities(options.prompt);
    const candidates: ResolvedEntry[] = [];
    const router = this;
    for (let i = 0; i < this.normalized.length; i++) {
      if (supportsAll(this.normalized[i].supports, required)) {
        const index = i;
        candidates.push({
          entry: this.normalized[i].original,
          // Instantiate lazily, on first access, so a later candidate whose
          // factory throws (or yields a non-v4 model) is treated as a normal
          // candidate failure (classified + fallen through) rather than aborting
          // the whole request before a healthy higher-priority candidate runs.
          get model() {
            return router.instantiate(index);
          },
          fullIndex: i,
        });
      }
    }

    let startIndex = 0;
    if (this.cooldown) {
      this.cooldown.checkAndReset();
      const active = this.cooldown.current();
      // Honor the sticky survivor ONLY when it is itself present in this request's
      // modality-filtered set. If it was filtered out, re-probe from the top
      // rather than skipping forward to a later candidate (which would silently
      // bypass a healthy higher-priority candidate for this modality).
      const pos = candidates.findIndex(
        (candidate) => candidate.fullIndex === active
      );
      startIndex = pos === -1 ? 0 : pos;
    }
    return { candidates, startIndex };
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
  options: CreateRouterOptions
): (logicalId: string) => LanguageModel {
  const { models } = options;

  return (logicalId: string): LanguageModel => {
    const entries = models[logicalId];
    if (!entries) {
      throw new Error(`ai-router: unknown model id "${logicalId}"`);
    }
    if (entries.length === 0) {
      throw new Error(
        `ai-router: model id "${logicalId}" has no provider entries`
      );
    }
    return new RouterLanguageModel(logicalId, entries, options);
  };
}
