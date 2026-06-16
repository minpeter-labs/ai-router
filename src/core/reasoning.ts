import type { LanguageModelMiddleware } from "ai";

/**
 * Provider-agnostic scaffolding for a `transformRequestBody` hook that turns the
 * OpenAI-style `reasoning_effort` field into a provider's native reasoning shape.
 *
 * Each provider supplies an `applyReasoning` that writes its own dialect into the
 * body (see `src/provider/<name>/reasoning.ts`); this helper owns everything that
 * is the same across providers.
 *
 * The returned hook runs AFTER `getArgs` has assembled the OpenAI-style body, so
 * `body.reasoning_effort` is present when the user passed a top-level `reasoning`
 * option (low|medium|high|minimal|xhigh) or
 * `providerOptions.<provider>.reasoningEffort`.
 *
 * It strips the foreign `reasoning_effort` and classifies it:
 *  - `'none'` / `false` -> reasoning off (`enabled = false`)
 *  - anything else       -> reasoning on (`enabled = true`)
 * then hands `(body, enabled)` to `applyReasoning` to write the native field.
 *
 * If no reasoning was requested (`reasoning_effort` absent), the body is returned
 * unchanged (a fresh clone — the input is never mutated).
 *
 * The AI SDK collapses a top-level `reasoning: 'none'` to an absent
 * `reasoning_effort` before this hook runs, so `'none'` would never reach here on
 * its own. {@link reasoningMiddleware} promotes the call-level `reasoning` option
 * (which still carries `'none'`) back into
 * `providerOptions.<provider>.reasoningEffort`, so disabling works through the
 * plain `reasoning: 'none'` option.
 *
 * @param applyReasoning writes the provider's native reasoning field into the
 *   already-cloned `body`. Mutating `body` is safe — it is never the caller's
 *   object. It receives the classified `enabled` flag plus the original
 *   `effort` value (the raw `reasoning_effort`, e.g. a level string like
 *   `'high'` or a boolean): on/off dialects can ignore it, while a provider
 *   that maps levels natively can forward the granular level.
 */
export function createReasoningTransform(
  applyReasoning: (
    body: Record<string, unknown>,
    enabled: boolean,
    effort: unknown
  ) => void
): (args: Record<string, unknown>) => Record<string, unknown> {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const effort = args.reasoning_effort;

    // No reasoning requested -> return an untouched clone (keeps the key if set).
    if (effort == null) {
      return { ...args };
    }

    // Drop reasoning_effort without a mutating `delete`; `body` is a fresh clone
    // of the remaining keys.
    const { reasoning_effort: _omit, ...body } = args;
    applyReasoning(body, !(effort === "none" || effort === false), effort);
    return body;
  };
}

/**
 * Middleware that lets the plain `reasoning` option control reasoning end to
 * end — including disabling it.
 *
 * `getArgs` in `@ai-sdk/openai-compatible` turns a call-level `reasoning` into a
 * body `reasoning_effort` for every level EXCEPT `'none'`, which it silently
 * drops. By the time a {@link createReasoningTransform} hook sees the body, that
 * `'none'` intent is gone.
 *
 * This `transformParams` hook runs earlier, on the call options, where
 * `reasoning` still holds its original value. It copies that value into
 * `providerOptions.<name>.reasoningEffort`, which `getArgs` always forwards to
 * the body as `reasoning_effort` (including `'none'`). The result then reaches
 * the provider's transform and is rewritten into its native field.
 *
 * Precedence is preserved: an explicit `providerOptions.<name>.reasoningEffort`
 * is left untouched, and `'provider-default'` / absent reasoning is a no-op so
 * the provider's own default stands.
 *
 * @param name the provider's `providerOptions` key (e.g. `'friendli'`).
 */
export function reasoningMiddleware(name: string): LanguageModelMiddleware {
  return {
    transformParams: ({ params }) => {
      const reasoning = params.reasoning;
      // Leave the provider default in place when nothing actionable was asked.
      if (reasoning == null || reasoning === "provider-default") {
        return Promise.resolve(params);
      }

      const providerOptions = params.providerOptions ?? {};
      // An explicit reasoningEffort wins; don't clobber it.
      if (providerOptions[name]?.reasoningEffort != null) {
        return Promise.resolve(params);
      }

      return Promise.resolve({
        ...params,
        providerOptions: {
          ...providerOptions,
          [name]: { ...providerOptions[name], reasoningEffort: reasoning },
        },
      });
    },
  };
}
