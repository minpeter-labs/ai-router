# @minpeter/ai-router

Provider-agnostic, modality-aware language model router with fallback for the
[Vercel AI SDK](https://sdk.vercel.ai) (v7 / provider spec v4).

```bash
pnpm add @minpeter/ai-router ai @ai-sdk/openai-compatible
```

## Router

```ts
import { createRouter } from '@minpeter/ai-router';
import { createFriendli } from '@minpeter/ai-router/friendli';
import { createOpenRouter } from '@minpeter/ai-router/openrouter';
import { generateText } from 'ai';

const friendli = createFriendli();
const openrouter = createOpenRouter();

const onError = ({ logicalId, error }) => console.warn(`[${logicalId}]`, error);

const router = createRouter({
  models: {
    kimi: [
      { provider: friendli,   model: 'moonshotai/Kimi-K2.5', supports: ['text'] },
      { provider: openrouter, model: 'moonshotai/kimi-k2.5', supports: ['text', 'image', 'video'] },
    ],
  },
  onError,
});

// `router('kimi')` returns a delegating model: it picks the first candidate
// whose `supports` covers the prompt's modalities, and falls back on error.
const model = router('kimi');

await generateText({
  model,             // the createRouter result
  messages,
  reasoning: 'low',  // forwarded to whichever candidate handles the request
});
```

For each request the router:

1. Detects the input modalities present in the prompt (`text`, `image`,
   `video`, `audio`, `pdf`).
2. Keeps the candidate entries whose `supports` covers them, in order.
3. Tries each candidate, calling `onError` and falling through on **retryable**
   failures (see below).
4. Throws if no candidate matches the modalities, or all matching candidates
   fail.

## Entry shapes

A candidate may be written three ways, mixed freely in one list:

```ts
createRouter({
  models: {
    kimi: [
      { provider: friendli, model: 'moonshotai/Kimi-K2.5', supports: ['text'] }, // factory
      { model: openrouter('moonshotai/kimi-k2.5'), supports: ['text', 'image'] }, // instance + supports
      anthropic('claude-haiku-4-5'),                                              // bare instance
    ],
  },
});
```

`supports` is **optional** — omit it and the entry becomes a universal
candidate that matches any modality (a handy catch-all / fallback tail).

## Fallback & retries

Failures are **classified** (by HTTP `statusCode`) before the router falls
through:

- A retryable status — `5xx`, `429`, and `401/403/408/409/413/498` — falls
  through to the next candidate.
- A recognized non-retryable client error (a `4xx` carrying a `statusCode`,
  e.g. a `400` bad-request — as the AI SDK's `APICallError` does) **stops
  immediately** and is surfaced, rather than burning through every candidate.
- A caller **abort / timeout** (your `abortSignal` fired, or a `TimeoutError`)
  **stops immediately** — it is never fanned out to other candidates.
- Anything else without a recognizable status (including a bare thrown `Error`)
  is treated as transient and retried — the historical behavior. Pass a custom
  `fallback.shouldRetry` for message-based or stricter policies.

All fallback tuning lives under one optional `fallback` object:

```ts
import { defaultShouldRetryThisError } from '@minpeter/ai-router';

createRouter({
  models,
  fallback: {
    // Replaces the default classifier. Compose on top of the bundled default:
    shouldRetry: (error) => isMyTransient(error) || defaultShouldRetryThisError(error),
    retryAfterOutput: false, // (default) — see below
    cooldown: '1m',          // see "Cooldown" below
  },
});
```

**Mid-stream fallback.** An error that arrives _after_ the stream opens but
_before_ any content is emitted triggers a transparent fallback to the next
candidate — the failed candidate's error is swallowed, never shown to the
consumer. Once content has streamed, the default (`fallback.retryAfterOutput:
false`) surfaces the error rather than risk duplicated output; set it `true` to
retry anyway (the next candidate re-emits from scratch, so output may
duplicate). This defaults `false` — unlike `ai-fallback`, which defaults `true`.

**When all candidates fail:** a single failure is re-thrown as-is; multiple
failures throw an `AggregateError` whose `.errors` holds every candidate error
and whose `.message` embeds the last one.

## Cooldown (sticky fallback)

Opt in with `fallback.cooldown` to remember the surviving candidate per logical
id, so later requests skip a known-down primary and re-probe it after the
interval (default 3 min). Off by default — the router is otherwise fully
stateless. Stickiness requires reusing the same `route('id')` instance.

```ts
const route = createRouter({
  models,
  fallback: { cooldown: '1m' },
  //         cooldown: true            // default (3 minutes)
  //         cooldown: 60_000          // milliseconds
  //         cooldown: { modelResetInterval: 60_000 }  // explicit
});
const chat = route('kimi'); // reuse this instance across requests
```

## Providers

`./friendli` and `./openrouter` are thin `@ai-sdk/openai-compatible` wrappers
that translate the AI SDK's reasoning request into each provider's native field
(and strip the foreign `reasoning_effort`):

| Provider   | becomes                                  |
| ---------- | ---------------------------------------- |
| Friendli   | `chat_template_kwargs.thinking: boolean` |
| OpenRouter | `reasoning.enabled: boolean`             |

```ts
// The plain `reasoning` option drives it on AND off — no providerOptions needed.
// (A built-in transformParams middleware keeps `reasoning: 'none'` alive, which
// the AI SDK would otherwise drop before the wrapper sees it.)
await streamText({
  model: createFriendli()('moonshotai/Kimi-K2.5'),
  reasoning: 'high', // any level (low|medium|high|…) -> thinking = true
  prompt: '...',
});

await streamText({
  model: createFriendli()('moonshotai/Kimi-K2.5'),
  reasoning: 'none', // -> thinking = false
  prompt: '...',
});
```

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
