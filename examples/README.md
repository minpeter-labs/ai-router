# Examples

Runnable with [`tsx`](https://github.com/privatenumber/tsx) (a dev dependency).

| File          | Network? | Key?              | Run                   |
| ------------- | -------- | ----------------- | --------------------- |
| `offline.ts`  | No       | No                | `pnpm example:offline` |
| `basic.ts`    | Yes      | At least one      | `pnpm example`        |

## `offline.ts` — smoke test

Drives a full `generateText` round-trip through the router with **no API key and
no network**: each provider is handed a fake `fetch` that answers with a canned
`chat.completion`. It verifies modality detection, the happy path, and the
fallback path (a retryable `503` on the primary falls through to the next
candidate, with `onError` firing). Doubles as a quick check that an installed
build of the package is wired up correctly.

```bash
pnpm example:offline
```

## `basic.ts` — real providers

Talks to the actual Friendli / OpenRouter APIs. Set at least one key:

```bash
FRIENDLI_TOKEN=...     pnpm example
OPENROUTER_API_KEY=... pnpm example
```

With both set you get genuine fallback — if Friendli rejects the request the
router transparently retries the same logical model on OpenRouter.
