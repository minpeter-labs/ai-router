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
 * One candidate backend for a logical model id.
 *
 * @example
 * { provider: createFriendli(), model: 'K2-Instruct', supports: ['text'] }
 */
export interface ProviderEntry {
  /** The provider-specific model id passed to `provider(model)`. */
  model: string;
  /** Factory that instantiates the underlying model (e.g. a provider instance). */
  provider: ProviderFactory;
  /** Input modalities this backend can handle. */
  supports: Modality[];
}

/**
 * Called when a candidate entry throws during `doGenerate`/`doStream`, just
 * before the router moves on to the next candidate. Use it for logging /
 * metrics. It must not throw; its return value is ignored.
 */
export type OnRouterError = (info: {
  /** Logical model id that was requested. */
  logicalId: string;
  /** The candidate entry that failed. */
  entry: ProviderEntry;
  /** Zero-based index of the failed entry within the candidate list. */
  index: number;
  /** The error thrown by the candidate. */
  error: unknown;
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
}
