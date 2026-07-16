---
"@minpeter/ai-router": patch
---

Harden fallback routing across generate and stream paths. The router now applies
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
