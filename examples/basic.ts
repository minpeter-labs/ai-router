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

const { text, finalStep } = await generateText({
  model: router("gemma-4-31B-it"),
  prompt: "In one sentence, what is a language model router?",
  reasoning: "none",
});

const dim = (s: string) =>
  process.stdout.isTTY
    ? `${String.fromCharCode(27)}[2m${s}${String.fromCharCode(27)}[0m`
    : s;

if (finalStep.reasoningText) {
  process.stdout.write(`${dim(`💭  ${finalStep.reasoningText}`)}\n\n`);
}

process.stdout.write(`${text}\n`);
