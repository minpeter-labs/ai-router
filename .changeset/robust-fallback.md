---
"@minpeter/ai-router": patch
---

Robust fallback upgrade (all additive, 100% backward compatible):

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
