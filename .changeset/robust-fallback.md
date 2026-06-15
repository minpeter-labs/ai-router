---
"@minpeter/ai-router": minor
---

Robust fallback upgrade (all additive, 100% backward compatible):

- **Mid-stream fallback** — an error that arrives after a stream opens but before any content is emitted now falls back to the next candidate transparently (previously only pre-open errors were caught). Gated on `retryAfterOutput` (default `false`) to avoid duplicated output.
- **Error classification** — failures are now classified via `defaultShouldRetryThisError` (retryable status codes / message patterns) so a non-retryable client error (e.g. a `400`) stops immediately instead of burning through every candidate. Override with the new `shouldRetryThisError` option.
- **`AggregateError` surfacing** — when several candidates fail, the router throws an `AggregateError` of every candidate error (a single failure still surfaces verbatim).
- **Opt-in cooldown** — `cooldown: true | { modelResetInterval }` makes the router stick to the surviving candidate per logical id and re-probe the primary after the interval (default 3 min). Off by default (stateless).
- **`supports` is now optional** — an entry with no `supports` matches any modality.
- **Direct model instances** — a candidate may be a ready v4 `LanguageModelV4` instance (`{ model }` or a bare instance) in addition to the `{ provider, model }` factory form.
- New exports: `defaultShouldRetryThisError`, `normalizeError`, `surfaceFailure`, and types `ProviderEntryFactory`, `ProviderEntryInstance`, `ShouldRetryThisError`, `CooldownConfig`. The `onError` context gains optional `phase` and `willRetry` fields.
