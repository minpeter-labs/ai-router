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
import { streamText } from 'ai';

const friendli = createFriendli();
const openrouter = createOpenRouter();

const route = createRouter({
  models: {
    chat: [
      { provider: friendli, model: 'K2-Instruct', supports: ['text'] },
      { provider: openrouter, model: 'moonshotai/kimi-k2', supports: ['text', 'image'] },
    ],
  },
  onError: ({ logicalId, error }) => console.warn(`[${logicalId}]`, error),
});

// Picks the first candidate whose `supports` covers the prompt's modalities,
// falls back to the next on error.
await streamText({ model: route('chat'), prompt: 'hello' });
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
// Enable — top-level `reasoning` or providerOptions both work:
await streamText({
  model: createFriendli()('moonshotai/Kimi-K2.5'),
  reasoning: 'high', // any level (low|medium|high|…) -> thinking = true
  prompt: '...',
});

// Disable — use providerOptions. The AI SDK drops a top-level `reasoning: 'none'`
// before the wrapper can see it, so 'none' must come through providerOptions:
await streamText({
  model: createFriendli()('moonshotai/Kimi-K2.5'),
  providerOptions: { friendli: { reasoningEffort: 'none' } }, // -> thinking = false
  prompt: '...',
});
```

## License

MIT
