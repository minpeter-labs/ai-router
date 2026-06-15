# Examples

Run with [`tsx`](https://github.com/privatenumber/tsx) (a dev dependency).

## `basic.ts` — real providers

Talks to the actual Friendli / OpenRouter APIs.

1. Copy `.env.example` to `.env` at the repo root and fill in at least one key:

   ```bash
   cp .env.example .env
   # FRIENDLI_TOKEN=...
   # OPENROUTER_API_KEY=...
   ```

2. Run it (`dotenv` loads `.env` automatically):

   ```bash
   pnpm example
   ```

With both keys set you get genuine fallback — if Friendli rejects the request
the router transparently retries the same logical model on OpenRouter.
