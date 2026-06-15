// Offline smoke test — runs with NO API key and hits NO network.
//
// Each provider here is given a fake `fetch` (the same trick the unit tests use):
// it answers with a canned OpenAI `chat.completion` instead of calling out. That
// lets us drive a real `generateText` round-trip through the router and watch the
// fallback path fire, end to end, against the actual published package.
//
//   pnpm example:offline

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createRouter, detectModalities } from "@minpeter/ai-router";
import { createFriendli } from "@minpeter/ai-router/friendli";
import { createOpenRouter } from "@minpeter/ai-router/openrouter";
import { generateText } from "ai";

/** Throw with `message` unless `ok` — a plain runtime guard, not a test assertion. */
function check(ok: boolean, message: string): void {
  if (!ok) {
    throw new Error(message);
  }
}

/** A fake `fetch` that always replies with a valid chat.completion carrying `content`. */
function okFetch(content: string): typeof globalThis.fetch {
  return () =>
    Promise.resolve(
      Response.json({
        id: "1",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
}

/** A fake `fetch` that always fails with the given HTTP status. */
function errFetch(status: number): typeof globalThis.fetch {
  return () =>
    Promise.resolve(
      Response.json(
        { error: { message: `synthetic ${status}`, type: "server_error" } },
        { status }
      )
    );
}

// 1) Modality detection is a pure, key-free function — verify it first.
const modalities = detectModalities([
  { role: "user", content: [{ type: "text", text: "hello" }] },
]);
check(
  modalities.size === 1 && modalities.has("text"),
  `expected Set {"text"}, got ${JSON.stringify([...modalities])}`
);
process.stdout.write(
  `modalities([text]) -> ${JSON.stringify([...modalities])}\n`
);

// 2) Happy path: a single fake provider answers, generateText returns its content.
const happy = createRouter({
  models: {
    kimi: [
      {
        provider: createFriendli({
          apiKey: "test",
          fetch: okFetch("hello-from-friendli"),
        }),
        model: "moonshotai/Kimi-K2.5",
        supports: ["text"],
      },
    ],
  },
});

const first = await generateText({ model: happy("kimi"), prompt: "hi" });
check(
  first.text === "hello-from-friendli",
  `happy path: expected "hello-from-friendli", got "${first.text}"`
);
process.stdout.write(`happy path -> "${first.text}"\n`);

// 3) Fallback: the primary fails with a retryable 503, so the router falls through
//    to the second candidate transparently. `onError` sees the swallowed failure.
const seen: string[] = [];
const withFallback = createRouter({
  models: {
    kimi: [
      {
        provider: createFriendli({ apiKey: "test", fetch: errFetch(503) }),
        model: "moonshotai/Kimi-K2.5",
        supports: ["text"],
      },
      {
        provider: createOpenRouter({
          apiKey: "test",
          fetch: okFetch("hello-from-openrouter"),
        }),
        model: "moonshotai/kimi-k2.5",
        supports: ["text"],
      },
    ],
  },
  onError: ({ logicalId }) => seen.push(logicalId),
});

const second = await generateText({
  model: withFallback("kimi"),
  prompt: "hi",
});
check(
  second.text === "hello-from-openrouter",
  `fallback: expected "hello-from-openrouter", got "${second.text}"`
);
check(
  seen.includes("kimi"),
  "onError should have fired for the downed primary"
);
process.stdout.write(
  `fallback   -> "${second.text}" (primary 503 swallowed, onError fired)\n`
);

// `createOpenAICompatible` is imported only to confirm the peer dep resolves cleanly.
check(
  typeof createOpenAICompatible === "function",
  "peer dep @ai-sdk/openai-compatible should resolve"
);

process.stdout.write(
  "\nOK — published @minpeter/ai-router works end to end (offline).\n"
);
