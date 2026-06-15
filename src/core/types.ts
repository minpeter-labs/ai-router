import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';

/**
 * Input modalities the router can detect in a prompt and match against a
 * provider entry's declared `supports` list.
 *
 * - `text`  — system content, text parts, reasoning parts.
 * - `image` — file parts with a top-level `image` media type (e.g. image/png, image/*, image).
 * - `video` — file parts with a top-level `video` media type.
 * - `audio` — file parts with a top-level `audio` media type.
 * - `pdf`   — file parts with media type `application/pdf` (special-cased).
 */
export type Modality = 'text' | 'image' | 'video' | 'audio' | 'pdf';

/**
 * Factory that produces a concrete AI SDK language model for a given model id.
 * This is exactly the shape returned by `createOpenAICompatible(...)`,
 * `createFriendli(...)`, `createOpenRouter(...)`, etc.
 */
export type ProviderFactory = (modelId: string) => LanguageModel;

/**
 * Classic factory candidate: a provider factory plus the model id to build.
 *
 * `supports` is optional — omit it to make the entry a universal candidate that
 * any prompt's modalities can route to (a catch-all / fallback tail).
 *
 * @example
 * { provider: createFriendli(), model: 'K2-Instruct', supports: ['text'] }
 * { provider: createFriendli(), model: 'K2-Instruct' } // matches any modality
 */
export interface ProviderEntryFactory {
  /** Factory that instantiates the underlying model (e.g. a provider instance). */
  provider: ProviderFactory;
  /** The provider-specific model id passed to `provider(model)`. */
  model: string;
  /** Input modalities this backend can handle. Omit to match any modality. */
  supports?: Modality[];
}

/**
 * Instance candidate: a ready-built v4 language model wrapped in an object so a
 * `supports` list can be attached.
 *
 * @example
 * { model: createFriendli()('K2-Instruct'), supports: ['text'] }
 */
export interface ProviderEntryInstance {
  /** A pre-built v4 `LanguageModel` (e.g. `provider('id')` or `wrapLanguageModel(...)`). */
  model: LanguageModelV4;
  /** Input modalities this backend can handle. Omit to match any modality. */
  supports?: Modality[];
  /** Must be absent — this discriminates the instance form from the factory form. */
  provider?: undefined;
}

/**
 * One candidate backend for a logical model id. Three accepted shapes:
 *
 *  - `{ provider, model: string, supports? }` — factory form (back-compat).
 *  - `{ model: <LanguageModelV4>, supports? }` — instance-object form.
 *  - `<LanguageModelV4>` — bare instance shorthand (matches any modality).
 *
 * The bare-instance member is the narrow `LanguageModelV4` (not the wider
 * `LanguageModel`, which would also admit a bare model-id string).
 */
export type ProviderEntry =
  | ProviderEntryFactory
  | ProviderEntryInstance
  | LanguageModelV4;

/**
 * Classifies an error as retryable (`true` — fall through to the next candidate)
 * or terminal (`false` — stop and surface the error). Must be pure and sync; a
 * throw inside it is treated as "not retryable".
 */
export type ShouldRetryThisError = (error: unknown) => boolean;

/**
 * Opt-in sticky+reset ("cooldown") configuration. When enabled, the router
 * remembers the surviving candidate per logical id so subsequent requests skip a
 * known-down primary, re-probing it after {@link CooldownConfig.modelResetInterval}.
 */
export interface CooldownConfig {
  /**
   * Milliseconds a non-primary survivor stays sticky before the next request
   * re-probes the primary. Default `180000` (3 minutes).
   */
  modelResetInterval?: number;
}

/**
 * Called when a candidate entry fails during `doGenerate`/`doStream`, just before
 * the router decides whether to fall through. Use it for logging / metrics. It
 * must not throw; its return value is ignored.
 *
 * The first four fields are stable; `phase` and `willRetry` are additive.
 */
export type OnRouterError = (info: {
  /** Logical model id that was requested. */
  logicalId: string;
  /** The candidate entry that failed — the user's original `ProviderEntry`. */
  entry: ProviderEntry;
  /** Zero-based index of the failed entry within the candidate list. */
  index: number;
  /** The error thrown by the candidate, or the in-band error-part value. */
  error: unknown;
  /** Where the failure happened. (additive) */
  phase?: 'generate' | 'stream-open' | 'stream-mid';
  /** Whether the router will retry another candidate after this error. (additive) */
  willRetry?: boolean;
}) => void;

/**
 * Options for {@link createRouter}.
 */
export interface CreateRouterOptions {
  /**
   * Map of logical model id -> ordered list of candidate backends.
   * Candidates are tried in array order (after modality filtering).
   */
  models: Record<string, ProviderEntry[]>;
  /** Optional hook invoked each time a candidate fails before falling back. */
  onError?: OnRouterError;
  /**
   * Custom retry classifier. When provided it REPLACES the default classifier
   * (it is not composed). Returning `false` stops fallback and surfaces the
   * error; returning `true` falls through to the next candidate. Defaults to
   * {@link defaultShouldRetryThisError}.
   */
  shouldRetryThisError?: ShouldRetryThisError;
  /**
   * Whether to fall back after content has already streamed. Default `false`:
   * once any content part has been emitted, a mid-stream error is surfaced
   * as-is rather than risk duplicated output. Set `true` to retry anyway
   * (the next candidate re-emits from scratch, so output may be duplicated).
   */
  retryAfterOutput?: boolean;
  /**
   * Opt-in sticky+reset. Omit / `false` => fully stateless (every request starts
   * at the first candidate — the default). `true` => defaults
   * (`modelResetInterval: 180000`). An object tunes the interval.
   */
  cooldown?: CooldownConfig | boolean;
}
