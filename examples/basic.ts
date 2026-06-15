// Real usage — talks to the actual Friendli / OpenRouter APIs.
//
// 1. Copy .env.example to .env at the repo root and fill in your key(s).
// 2. Run it:  pnpm example
//
// Set at least one key; with both set you get genuine fallback — if Friendli
// rejects the request, the router transparently retries the same logical model
// on OpenRouter.

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env", quiet: true, override: true });

import { createRouter } from "@minpeter/ai-router";
import { createFriendli } from "@minpeter/ai-router/friendli";
import { createOpenRouter } from "@minpeter/ai-router/openrouter";
import { generateText } from "ai";

if (!(process.env.FRIENDLI_TOKEN || process.env.OPENROUTER_API_KEY)) {
  process.stdout.write(
    "No key found. Add FRIENDLI_TOKEN and/or OPENROUTER_API_KEY to a .env file " +
      "at the repo root (see .env.example), then run `pnpm example`.\n"
  );
  process.exit(0);
}

const router = createRouter({
  models: {
    "gemma-4-31B-it": [
      {
        provider: createFriendli(),
        model: "google/gemma-4-31B-it",
        supports: ["text"],
      },
      {
        provider: createOpenRouter(),
        model: "google/gemma-4-31b-it:nitro",
        supports: ["text", "image"],
      },
    ],
  },
  onError: ({ logicalId, error }) =>
    process.stderr.write(`[${logicalId}] fell through: ${String(error)}\n`),
});

const { text, steps } = await generateText({
  model: router("gemma-4-31B-it"),
  prompt: "In one sentence, what is a language model router?",
  reasoning: "low",
});

// Reasoning lives on the final step (the top-level `reasoningText` is deprecated).
const reasoningText = steps.at(-1)?.reasoningText;

// Print any reasoning dimmed/gray so it reads as secondary next to the answer.
// Only colorize a real terminal — stays clean when piped to a file.
const ESC = String.fromCharCode(27); // ANSI escape; no raw control byte in source
const dim = (s: string) =>
  process.stdout.isTTY ? `${ESC}[2m${s}${ESC}[0m` : s;

if (reasoningText) {
  process.stdout.write(`${dim(`💭 ${reasoningText}`)}\n\n`);
}
process.stdout.write(`${text}\n`);
