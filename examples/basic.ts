// Real usage — talks to actual providers. Set at least one key, then run:
//
//   FRIENDLI_TOKEN=...     pnpm example
//   OPENROUTER_API_KEY=... pnpm example
//
// With both set you get genuine fallback: if Friendli rejects the request the
// router transparently retries the same logical model on OpenRouter. With only
// one key set, the other candidate fails its auth and the router falls through.

import { createRouter } from "@minpeter/ai-router";
import { createFriendli } from "@minpeter/ai-router/friendli";
import { createOpenRouter } from "@minpeter/ai-router/openrouter";
import { generateText } from "ai";

if (!(process.env.FRIENDLI_TOKEN || process.env.OPENROUTER_API_KEY)) {
  process.stdout.write(
    "Set FRIENDLI_TOKEN and/or OPENROUTER_API_KEY to run this example.\n" +
      "No key needed for the offline smoke test: pnpm example:offline\n"
  );
  process.exit(0);
}

const router = createRouter({
  models: {
    kimi: [
      {
        provider: createFriendli(),
        model: "moonshotai/Kimi-K2.5",
        supports: ["text"],
      },
      {
        provider: createOpenRouter(),
        model: "moonshotai/kimi-k2.5",
        supports: ["text"],
      },
    ],
  },
  onError: ({ logicalId, error }) =>
    process.stderr.write(`[${logicalId}] fell through: ${String(error)}\n`),
});

const { text } = await generateText({
  model: router("kimi"),
  prompt: "In one sentence, what is a language model router?",
  reasoning: "low",
});

process.stdout.write(`${text}\n`);
