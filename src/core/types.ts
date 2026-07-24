import type {
  LanguageModelV4,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

/**
 * Input modalities the router can detect in a prompt and match against a
 * provider entry's declared `supports` list.
 *
 * - `text`  — system content, text parts, reasoning parts.
 * - `image` — file parts with a top-level `image` media type (e.g. image/png, image/*, image).
 * - `video` — file parts with a top-level `video` media type.
 * - `audio` — file parts with a top-level `audio` media type.
 * - `pdf`   — file parts with media type `application/pdf` (special-cased).
 * - `file`  — other file parts whose media type has no specialized modality.
 */
export type Modality = "text" | "image" | "video" | "audio" | "pdf" | "file";

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
  /** AIMD concurrency tuning; `true` uses defaults. */
  adaptiveConcurrency?: boolean | AdaptiveConcurrencyConfig;
  /** Stable non-secret credential identity used for shared health cooldowns. */
  healthKey?: string;
  /** Maximum concurrent attempts for this credential/routing entry. */
  maxConcurrency?: number;
  /** The provider-specific model id passed to `provider(model)`. */
  model: string;
  /** Factory that instantiates the underlying model (e.g. a provider instance). */
  provider: ProviderFactory;
  /** Optional stable non-secret family identity shared by related candidates. */
  providerFamily?: string;
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
  /** AIMD concurrency tuning; `true` uses defaults. */
  adaptiveConcurrency?: boolean | AdaptiveConcurrencyConfig;
  /** Stable non-secret credential identity used for shared health cooldowns. */
  healthKey?: string;
  /** Maximum concurrent attempts for this credential/routing entry. */
  maxConcurrency?: number;
  /** A pre-built v4 `LanguageModel` (e.g. `provider('id')` or `wrapLanguageModel(...)`). */
  model: LanguageModelV4;
  /** Must be absent — this discriminates the instance form from the factory form. */
  provider?: undefined;
  /** Optional stable non-secret family identity shared by related candidates. */
  providerFamily?: string;
  /** Input modalities this backend can handle. Omit to match any modality. */
  supports?: Modality[];
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

export type FailureScope =
  | "request"
  | "credential"
  | "routing-unit"
  | "provider-family"
  | "transient";

export interface FailureClassification {
  /** Optional health cooldown floor for this classified failure. */
  cooldownMs?: number;
  retryAfterMs?: number;
  retryable: boolean;
  scope: FailureScope;
  statusCode?: number;
}

export type ClassifyFailure = (error: unknown) => FailureClassification;

export type ValidateGenerateResult = (
  result: LanguageModelV4GenerateResult
) => boolean | string;

export type RouterAttemptOutcome =
  | "success"
  | "failure"
  | "skipped"
  | "cancelled";

export interface AdaptiveConcurrencyConfig {
  increaseAfterSuccesses?: number;
  initial?: number;
  max?: number;
  min?: number;
}

export interface RetryBudgetConfig {
  /** Maximum retained outcomes. Defaults to 20. */
  maxSamples?: number;
  /** Minimum outcomes before tripping. Defaults to 5. */
  minSamples?: number;
  /** Failure rate below which a tripped budget recovers. Defaults to 0.4. */
  recoveryFailureRate?: number;
  /** Failure rate at which the budget trips. Defaults to 0.8. */
  tripFailureRate?: number;
  /** Observation window. Defaults to 60 seconds. */
  window?: Duration | number;
}

export interface RouterRetryBudgetSnapshot {
  available: boolean;
  failureRate: number;
  failures: number;
  logicalId: string;
  samples: number;
  tripped: boolean;
  windowMs: number;
}

export interface RouterAdmissionSnapshot {
  adaptive: boolean;
  increaseAfterSuccesses?: number;
  index: number;
  inFlight: number;
  limit?: number;
  logicalId: string;
  max?: number;
  min?: number;
  successes?: number;
  waiting: number;
}

/** Opaque health ordering token. Numeric values remain accepted for old stores. */
export type RouterOrderingToken = number | string;

export interface RouterHealthRecord {
  cooldownUntil: number;
  failures: number;
  /** Monotonic ordering token of the last failed attempt (not wall-clock ms). */
  lastFailureAt?: RouterOrderingToken;
  lastStatus?: number;
  /** Monotonic ordering token of the last successful attempt. */
  lastSuccessAt?: RouterOrderingToken;
  /** Wall-clock observation time used only for stale-record pruning. */
  observedAtMs?: number;
  probingUntil?: number;
  version?: number;
}

export interface RouterHealthStore {
  compareAndSet?(
    key: string,
    expectedVersion: number | undefined,
    value: RouterHealthRecord
  ): boolean;
  delete(key: string): void;
  entries?(): IterableIterator<[string, RouterHealthRecord]>;
  get(key: string): RouterHealthRecord | undefined;
  set(key: string, value: RouterHealthRecord): void;
}

export interface RouterHealthSnapshot {
  /** Diagnostic key; credential/family identity segments are fingerprinted. */
  key: string;
  record: RouterHealthRecord;
}

export interface Router {
  getAdmissionSnapshot(logicalId?: string): RouterAdmissionSnapshot[];
  getHealthSnapshot(logicalId?: string): RouterHealthSnapshot[];
  getRetryBudgetSnapshot(logicalId?: string): RouterRetryBudgetSnapshot[];
  (logicalId: string): LanguageModel;
}

export type OnRouterAttempt = (info: {
  /** One-based provider attempt number; absent when no provider call occurred. */
  attempt?: number;
  durationMs: number;
  entry: ProviderEntry;
  error?: unknown;
  failure?: FailureClassification;
  healthTransition?:
    | "cas-exhausted"
    | "cooling"
    | "deduplicated"
    | "ignored-stale"
    | "recovered";
  inFlight?: number;
  concurrencyLimit?: number;
  /** Stable index in the configured logical-model candidate array. */
  index: number;
  logicalId: string;
  outcome: RouterAttemptOutcome;
  phase: "generate" | "stream-open" | "stream-mid";
  reason?: "concurrency" | "cooldown" | "max-attempts";
  willRetry?: boolean;
}) => unknown;

/** A human-readable duration, e.g. `'500ms'`, `'30s'`, `'1m'`, `'2h'`. */
export type Duration =
  | `${number}ms`
  | `${number}s`
  | `${number}m`
  | `${number}h`;

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
 * How to configure cooldown. Omit / `false` => off (stateless, the default).
 * `true` => defaults (3 minutes). A `number` is milliseconds, a {@link Duration}
 * string is parsed (`'90s'`, `'1m'`), or pass a {@link CooldownConfig} explicitly.
 */
export type CooldownOption = boolean | number | Duration | CooldownConfig;

/**
 * Fallback behavior tuning for {@link createRouter} — all optional.
 */
export interface FallbackOptions {
  /** Maximum time for one provider to open a response. Disabled when omitted. */
  attemptTimeout?: Duration | number;
  /** Random delay ceiling between attempts; useful for burst de-synchronization. */
  backoff?: Duration | number | false;
  /** Structured failure classifier. Takes precedence over `shouldRetry`. */
  classifyFailure?: ClassifyFailure;
  /** Wait for a final candidate's concurrency slot before failing. */
  concurrencyWaitTimeout?: Duration | number;
  /**
   * Opt-in sticky+reset. Skip a known-down primary on later requests and
   * re-probe it after the interval. See {@link CooldownOption}.
   *
   * @example cooldown: true        // default (3 minutes)
   * @example cooldown: '1m'        // duration string
   * @example cooldown: 60_000      // milliseconds
   */
  cooldown?: CooldownOption;
  /** Maximum time to wait for the first meaningful stream output. */
  firstContentTimeout?: Duration | number;
  /** Track candidate health and skip cooling candidates. Defaults on with cooldown. */
  health?: boolean;
  /** Prefix for shared health keys; use one per service/environment. */
  healthNamespace?: string;
  /** Optional synchronous store/facade for cross-router health propagation. */
  healthStore?: RouterHealthStore;
  /** Maximum number of provider attempts per request. */
  maxAttempts?: number;
  /**
   * Whether to fall back after content has already streamed. Default `false`:
   * once any content part has been emitted, a mid-stream error is surfaced
   * as-is rather than risk duplicated output. Set `true` to retry anyway
   * (the next candidate re-emits from scratch, so output may be duplicated).
   */
  retryAfterOutput?: boolean;
  /** Opt-in sliding request-level failure budget, or its tuning policy. */
  retryBudget?: boolean | RetryBudgetConfig;
  /** Candidate ordering policy. Defaults to strict configured order. */
  selection?: "least-inflight" | "ordered" | "round-robin";
  /**
   * Custom retry classifier. When provided it REPLACES the default classifier
   * (it is not composed). Returning `false` stops fallback and surfaces the
   * error; returning `true` falls through to the next candidate. Defaults to
   * {@link defaultShouldRetryThisError}.
   */
  shouldRetry?: ShouldRetryThisError;
  /** Validate stream block lifecycle ordering. Disabled by default for compatibility. */
  strictStreamValidation?: boolean;
  /** Total wall-clock budget for all fallback attempts. Disabled when omitted. */
  totalTimeout?: Duration | number;
  /** Validate a successful non-streaming result. `true` accepts; string rejects. */
  validateResult?: ValidateGenerateResult;
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
  /** Stable zero-based index in the configured logical-model candidate array. */
  index: number;
  /** The error thrown by the candidate, or the in-band error-part value. */
  error: unknown;
  /** Where the failure happened. (additive) */
  phase?: "generate" | "stream-open" | "stream-mid";
  /** Whether the router will retry another candidate after this error. (additive) */
  willRetry?: boolean;
}) => unknown;

/**
 * Options for {@link createRouter}.
 */
export interface CreateRouterOptions {
  /** Fallback behavior tuning (retry classification, mid-stream retry, cooldown). */
  fallback?: FallbackOptions;
  /**
   * Map of logical model id -> ordered list of candidate backends.
   * Candidates are tried in array order (after modality filtering).
   */
  models: Record<string, ProviderEntry[]>;
  /** Attempt-level observability hook. Hook failures are ignored. */
  onAttempt?: OnRouterAttempt;
  /** Optional hook invoked each time a candidate fails before falling back. */
  onError?: OnRouterError;
}
