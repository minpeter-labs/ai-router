// Shared test fixtures for the openai-compatible providers (friendli, openrouter).
// No network is ever hit: `captureFetch` records the outgoing request and answers
// with a minimal-but-valid chat.completion.

/**
 * A minimal-but-valid OpenAI chat.completion JSON response. The openai-compatible
 * provider parses this into a generateText result. Returning a fresh Response per
 * call keeps the body stream unconsumed across requests.
 */
export function chatCompletionResponse(): Response {
  return Response.json({
    id: '1',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** What a {@link captureFetch} records about the single outgoing request. */
export interface CapturedRequest {
  body: Record<string, unknown>;
  headers: Headers;
  url?: string;
}

/**
 * Builds a fake `fetch` that records the outgoing request (url, headers, parsed
 * JSON body) and always answers with a valid chat.completion. No network is hit.
 */
/** Resolve a fetch `input` (string | URL | Request) to its URL string. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

export function captureFetch(): {
  fetch: typeof globalThis.fetch;
  captured: CapturedRequest;
} {
  const captured: CapturedRequest = { headers: new Headers(), body: {} };
  const fetch: typeof globalThis.fetch = (input, init) => {
    captured.url = requestUrl(input);
    captured.headers = new Headers(init?.headers as HeadersInit);
    if (typeof init?.body === 'string') {
      captured.body = JSON.parse(init.body);
    }
    return Promise.resolve(chatCompletionResponse());
  };
  return { fetch, captured };
}
