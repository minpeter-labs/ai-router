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
3. Tries each candidate, calling `onError` and falling through on failure.
4. Throws if no candidate matches the modalities, or all matching candidates
   fail.

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

## License

MIT
