import type { LanguageModelMiddleware } from "ai";

/**
 * Reasoning dialect for a downstream provider.
 *
 * - `friendli`   -> `chat_template_kwargs.thinking: boolean`
 * - `openrouter` -> `reasoning.enabled: boolean`
 */
export type ReasoningDialect = "friendli" | "openrouter";

/**
 * Build a `transformRequestBody` hook for `createOpenAICompatible`.
 *
 * The hook runs AFTER `getArgs` has assembled the OpenAI-style body, so
 * `body.reasoning_effort` is present when the user passed a top-level
 * `reasoning` option (low|medium|high|minimal|xhigh) or
 * `providerOptions.<provider>.reasoningEffort`.
 *
 * It removes the foreign `reasoning_effort` field and translates it into the
 * provider's own dialect:
 *  - `'none'` / `false` -> reasoning off
 *  - anything else (low|medium|high|minimal|xhigh|true|string) -> reasoning on
 *
 * If no reasoning was requested (`reasoning_effort` absent), the body is
 * returned unchanged.
 *
 * The AI SDK collapses a top-level `reasoning: 'none'` to an absent
 * `reasoning_effort` before this hook runs, so `'none'` would never reach here
 * on its own. {@link reasoningMiddleware} promotes the call-level `reasoning`
 * option (which still carries `'none'`) back into
 * `providerOptions.<provider>.reasoningEffort`, so disabling works through the
 * plain `reasoning: 'none'` option.
 */
export function translateReasoning(
  dialect: ReasoningDialect
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
    const enabled = !(effort === "none" || effort === false);

    if (dialect === "friendli") {
      body.chat_template_kwargs = {
        ...(body.chat_template_kwargs as Record<string, unknown> | undefined),
        thinking: enabled,
      };
    } else {
      body.reasoning = {
        ...(body.reasoning as Record<string, unknown> | undefined),
        enabled,
      };
    }

    return body;
  };
}

/**
 * Middleware that lets the plain `reasoning` option control reasoning end to
 * end — including disabling it.
 *
 * `getArgs` in `@ai-sdk/openai-compatible` turns a call-level `reasoning` into a
 * body `reasoning_effort` for every level EXCEPT `'none'`, which it silently
 * drops. By the time {@link translateReasoning} sees the body, that `'none'`
 * intent is gone.
 *
 * This `transformParams` hook runs earlier, on the call options, where
 * `reasoning` still holds its original value. It copies that value into
 * `providerOptions.<name>.reasoningEffort`, which `getArgs` always forwards to
 * the body as `reasoning_effort` (including `'none'`). The result then reaches
 * {@link translateReasoning} and is rewritten into the provider's native field.
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
