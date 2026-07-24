# @minpeter/ai-router

## 0.0.6

### Patch Changes

- 8b50095: Retry candidate-specific `provider_not_found` responses so unavailable pinned providers fall through in generate and stream routes.

## 0.0.5

### Patch Changes

- 6d5e27e: Harden fallback routing across generate and stream paths. The router now applies
  structured failure classification, provider/key/family health cooldowns,
  half-open probes, optional retry budgets, bounded Retry-After handling,
  per-attempt and total deadlines, first-content timeouts, max-attempt limits, and
  abortable backoff.

  Add shared and adaptive admission control with per-credential concurrency,
  abortable FIFO waiting, AIMD recovery, round-robin and least-inflight selection,
  and public health, admission, and retry-budget diagnostics. Export stable
  `RouterConcurrencyError`, `RouterHealthUnavailableError`, and timeout errors for
  callers that need to distinguish routing infrastructure failures.

  Validate and isolate provider inputs and outputs before fallback decisions.
  Generate envelopes, stream lifecycle parts, metadata, usage, warnings, call
  options, custom validators, observability hooks, health stores, and provider
  settings now use bounded snapshots and synchronous-contract checks. Malformed,
  empty, incomplete, late, or hostile provider results route through the same
  fallback policy without leaking resources or unhandled Promise rejections.

  Improve stream lifecycle ownership: downstream backpressure reaches upstream
  readers, cancellation releases reader locks and admission/probe ownership once,
  late streams are cancelled promptly, failed pre-output framing is discarded,
  and post-output retry remains explicitly controlled by `retryAfterOutput`.

  Improve OpenGateway reasoning round trips with bounded metadata composition,
  reasoning-details references, isolated optional callbacks and stores, and safe
  memoization. Harden Friendli, OpenRouter, OpenGateway, and Wafer settings capture
  while preserving their existing public provider entry points.

  Refactor oversized router, stream, admission, health, retry, provider-settings,
  and OpenGateway implementations into focused internal modules without changing
  the public API. Split large test suites into feature-oriented files with shared
  test kits so each behavior remains independently discoverable and runnable.

## 0.0.4

### Patch Changes

- 8d778b4: Refresh dependencies to the stable AI SDK v7 baseline.

## 0.0.3

### Patch Changes

- c87c41f: Friendli reasoning translation now sends both `chat_template_kwargs.thinking` and `chat_template_kwargs.enable_thinking` (same boolean). Friendli's reasoning toggle is model-dependent — most models read `thinking`, but some (e.g. Gemma 4) read `enable_thinking`. Emitting both makes the plain `reasoning` option drive thinking on/off regardless of which field the target model honors; a model ignores the field it doesn't recognize. Backward compatible.
- a331f7c: Add the Wafer provider export, including reasoning-effort translation, ZDR request enforcement, and preserved-reasoning controls for Wafer models.
- 8ad68fd: Add an OpenGateway provider entrypoint at `@minpeter/ai-router/opengateway`. It defaults to `https://apis.opengateway.ai/v1`, reads `OPENGATEWAY_API_KEY`, passes supported AI SDK `reasoning` levels through as OpenGateway's OpenAI-compatible `reasoning_effort` field, and preserves OpenGateway `reasoning_content` / `reasoning_details` across AI SDK multi-step and multi-turn messages.

## 0.0.2

### Patch Changes

- 9d9b64f: Reorganize the source tree: group providers into per-provider folders under `src/provider/` and shared core modules under `src/core/`. Pure structural move — no public API, behavior, or build-output change.
- 99aca76: Robust fallback upgrade (all additive, 100% backward compatible):

  Fallback tuning is grouped under one optional `fallback` object: `createRouter({ models, onError, fallback: { shouldRetry, retryAfterOutput, cooldown } })`.

  - **Mid-stream fallback** — an error that arrives after a stream opens but before any content is emitted now falls back to the next candidate transparently (previously only pre-open errors were caught). Gated on `fallback.retryAfterOutput` (default `false`) to avoid duplicated output.
  - **Error classification** — failures are now classified via `defaultShouldRetryThisError` (retryable status codes; aborts/timeouts and non-retryable client errors like `400` stop immediately instead of burning through every candidate). Override with `fallback.shouldRetry`.
  - **`AggregateError` surfacing** — when several candidates fail, the router throws an `AggregateError` of every candidate error (a single failure still surfaces verbatim).
  - **Opt-in cooldown** — `fallback.cooldown` (`true`, a millisecond `number`, a `'1m'` duration string, or `{ modelResetInterval }`) makes the router stick to the surviving candidate per logical id and re-probe the primary after the interval (default 3 min). Off by default (stateless).
  - **`supports` is now optional** — an entry with no `supports` matches any modality.
  - **Direct model instances** — a candidate may be a ready v4 `LanguageModelV4` instance (`{ model }` or a bare instance) in addition to the `{ provider, model }` factory form.
  - **Abort-aware** — a caller abort / timeout (`abortSignal`, `TimeoutError`) stops immediately instead of fanning out to other candidates.
  - **Lazy & resilient instantiation** — candidates are built only when attempted, so a broken later entry can't abort a request a healthy earlier one can serve. A multi-candidate router conservatively reports no native URL support (the SDK inlines URLs, which any candidate accepts).
  - New exports: `defaultShouldRetryThisError`, `normalizeError`, `surfaceFailure`, and types `FallbackOptions`, `CooldownOption`, `Duration`, `ProviderEntryFactory`, `ProviderEntryInstance`, `ShouldRetryThisError`, `CooldownConfig`. The `onError` context gains optional `phase` and `willRetry` fields.

## 0.0.1

### Patch Changes

- bd99b0d: The plain `reasoning` option now controls reasoning on **and** off. A `transformParams` middleware on each provider promotes the call-level `reasoning` value (including `'none'`, which the AI SDK would otherwise drop) into `providerOptions.<provider>.reasoningEffort`, so `reasoning: 'none'` disables thinking without needing `providerOptions`.
