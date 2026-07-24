# @minpeter/ai-router

Provider-agnostic, modality-aware fallback routing for the
[Vercel AI SDK](https://sdk.vercel.ai) v7 and provider spec v4.

```bash
pnpm add @minpeter/ai-router ai @ai-sdk/openai-compatible
```

The package ships ESM, CJS, and Node16/NodeNext-compatible declarations for the
root API and each provider subpath.

## Quick start

```ts
import { createRouter } from '@minpeter/ai-router';
import { createFriendli } from '@minpeter/ai-router/friendli';
import { createOpenRouter } from '@minpeter/ai-router/openrouter';
import { generateText } from 'ai';

const friendli = createFriendli();
const openrouter = createOpenRouter();

const route = createRouter({
  models: {
    kimi: [
      {
        provider: friendli,
        model: 'moonshotai/Kimi-K2.5',
        supports: ['text'],
      },
      {
        provider: openrouter,
        model: 'moonshotai/kimi-k2.5',
        supports: ['text', 'image', 'video'],
      },
    ],
  },
  onError: ({ logicalId, error }) => console.warn(logicalId, error),
});

const result = await generateText({
  model: route('kimi'),
  prompt: 'Hello',
});
```

For each request, the router detects `text`, `image`, `video`, `audio`, `pdf`,
and generic `file` inputs; keeps compatible candidates; and tries them in the
configured order until one succeeds or the retry policy stops.

## Candidate forms

Factory entries, wrapped instances, and bare V4 models can be mixed:

```ts
createRouter({
  models: {
    chat: [
      { provider: friendli, model: 'model-a', supports: ['text'] },
      { model: openrouter('model-b'), supports: ['text', 'image'] },
      anotherV4Model,
    ],
  },
});
```

`supports` is optional. An entry without it is a universal catch-all. Use
`file` for media types that are not image, audio, video, or PDF.

Candidates may also declare:

- `healthKey` to share credential-level health and admission state.
- `providerFamily` to share provider-family cooldowns.
- `maxConcurrency` for a fixed shared concurrency limit.
- `adaptiveConcurrency` for AIMD-based limits.

Health identities are operational labels, not secrets. Public snapshots expose
fingerprints instead of the original identity strings.

## Fallback policy

```ts
import { defaultShouldRetryThisError } from '@minpeter/ai-router';

const route = createRouter({
  models,
  fallback: {
    shouldRetry: error =>
      isApplicationTransient(error) || defaultShouldRetryThisError(error),
    classifyFailure: error => ({ retryable: true, scope: 'transient' }),
    retryAfterOutput: false,
    attemptTimeout: '20s',
    firstContentTimeout: '10s',
    totalTimeout: '45s',
    maxAttempts: 3,
    backoff: '40ms',
    cooldown: '1m',
    health: true,
    healthNamespace: 'my-service:production',
    retryBudget: true,
    selection: 'least-inflight',
    concurrencyWaitTimeout: '500ms',
    strictStreamValidation: true,
  },
  onAttempt: event => metrics.record(event),
});
```

The default classifier retries transient failures, `5xx`, rate limits, common
provider-scoped `4xx`, unavailable models/endpoints, and credential-specific
quota failures. Caller aborts and terminal request-contract failures do not fan
out. A custom `shouldRetry` replaces that boolean decision; compose it with
`defaultShouldRetryThisError` when the default should remain a fallback.

`classifyFailure` can attach a scope:

- `request`: caller or request-contract failure; never trains shared health.
- `routing-unit`: one configured model or endpoint.
- `credential`: candidates sharing a `healthKey`.
- `provider-family`: candidates sharing a `providerFamily`.
- `transient`: ordinary temporary provider failure.

`attemptTimeout`, `firstContentTimeout`, `totalTimeout`, attempt limits, retry
budgets, and backoff are opt-in. `RouterTimeoutError` exposes a stable `code`
and `durationMs` for typed handling.

Before output is committed, malformed, empty, incomplete, timed-out, or failed
streams can transparently move to another candidate. After output is committed,
the default is to surface the error; enable `retryAfterOutput` only when
duplicate/restarted output is acceptable.

## Health, admission, and diagnostics

Health, half-open probes, concurrency ownership, adaptive limits, and retry
budget decisions are shared where identities match. Optional shared health
stores can coordinate cooldown records across router instances.

```ts
const route = createRouter({ models, fallback: { health: true } });

route.getHealthSnapshot('chat');
route.getAdmissionSnapshot('chat');
route.getRetryBudgetSnapshot('chat');
```

Public errors include `RouterConcurrencyError`,
`RouterHealthUnavailableError`, `RouterTimeoutError`, `RouterTimerError`,
`RouterCancellationError`, and `RouterStreamError`.

Provider attempts receive isolated, bounded snapshots of mutable call options.
Provider results, stream parts, metadata, usage, warnings, custom callbacks,
and health-store values are validated before they influence fallback state.

## Providers

The package provides OpenAI-compatible wrappers at:

- `@minpeter/ai-router/friendli`
- `@minpeter/ai-router/openrouter`
- `@minpeter/ai-router/opengateway`
- `@minpeter/ai-router/wafer`

The AI SDK `reasoning` option maps to each provider's native request shape.
Friendli uses chat-template thinking flags, OpenRouter uses
`reasoning.enabled`, OpenGateway uses `reasoning_effort`, and Wafer preserves
the requested effort level.

```ts
import { createOpenGateway } from '@minpeter/ai-router/opengateway';
import { createWafer } from '@minpeter/ai-router/wafer';
import { streamText } from 'ai';

await streamText({
  model: createOpenGateway()('openai/gpt-4o-mini'),
  reasoning: 'high',
  prompt: 'Explain this design.',
});

const wafer = createWafer({ preserveReasoning: 'auto', zdr: true });
await streamText({
  model: wafer('GLM-5.1'),
  reasoning: 'high',
  prompt: 'Continue the analysis.',
});
```

Wafer `preserveReasoning` accepts `false`, `auto`, or `true`. `zdr: true`
adds `Wafer-ZDR: required` and fails closed when the account cannot guarantee
zero data retention.

OpenGateway round-trips `reasoning_content` and model-specific
`reasoning_details`. Its default bounded reference store is scoped to one
provider instance. Applications persisting messages across workers can provide
a durable store:

```ts
const opengateway = createOpenGateway({
  reasoningDetailsStore: {
    store(details) {
      const ref = crypto.randomUUID();
      durableStore.set(ref, details);
      return ref;
    },
    load(ref) {
      return durableStore.get(ref);
    },
  },
});
```

## Development

```bash
pnpm test
pnpm check:ci
pnpm build
```

Build validation checks every public runtime/type export and enforces package
artifact budgets so provider-only entry points do not pull in the router
runtime accidentally.

## Fusion

`./fusion` runs a **panel** of models in parallel, has a **judge** compare their
answers into a structured analysis (consensus / contradictions / blind spots /
…), and has a **synth** model write the final answer from that analysis. It's a
local, provider-agnostic take on multi-model deliberation — built only on
`LanguageModelV4` calls, with no dependency on any hosted fusion service.

```ts
import { createFusion } from '@minpeter/ai-router/fusion';
import { createOpenRouter } from '@minpeter/ai-router/openrouter';
import { generateText } from 'ai';

const or = createOpenRouter();

const fusion = createFusion({
  panel: [
    or('anthropic/claude-opus-4'),
    or('openai/gpt-5'),
    or('google/gemini-2.5-pro'),
  ],
  // judge defaults to the first surviving panel member; synth defaults to the judge.
});

const { text, providerMetadata } = await generateText({
  model: fusion, // a plain LanguageModelV4 — drops into generateText/streamText
  prompt: 'What are the strongest arguments for and against carbon taxes?',
});

// The structured analysis is attached for inspection:
console.log(providerMetadata?.fusion?.analysis);
```

`createFusion` returns a `LanguageModelV4`, so it composes with the router both
ways — a fusion model can be a router candidate, and a router (per-slot fallback)
can be a panel member:

```ts
createFusion({
  panel: [
    // this slot has its own ordered fallback (reuses the router internally)
    { fallback: [
      { provider: friendli,   model: 'K2.5',               supports: ['text'] },
      { provider: openrouter, model: 'moonshotai/kimi-k2.5', supports: ['text'] },
    ] },
    openrouter('openai/gpt-5'),
  ],
});
```

For each request fusion:

1. Filters the panel to members that can handle the prompt's modalities.
2. Answers in parallel, fault-tolerant — a member that fails is dropped (see
   `onError` / `minPanelSuccess`), the rest proceed.
3. Has the judge return structured JSON; if it fails or returns junk, fusion
   degrades to reconciling the raw answers rather than erroring.
4. Streams **only** the final answer (`doStream`); the panel and judge are
   buffered. `includeAnalysis: 'reasoning'` also surfaces the analysis as a
   reasoning block; `'metadata'` (default) attaches it to
   `providerMetadata.fusion`.

Key options: `judge`, `synth`, `panelTemperature` / `judgeTemperature` /
`synthTemperature`, `minPanelSuccess`, `onInsufficientPanel`, `concurrency`,
`includeAnalysis`, `modalityBehavior`, `onEvent`, `onError`. Nested fusion is
bounded by a recursion guard. Web search/fetch is intentionally out of scope for
now — panel/judge run without tools.

> Cost note: a panel of _N_ models is _N_ + 2 completions per request. Reach for
> fusion when being right matters more than the extra calls.

## License

MIT
