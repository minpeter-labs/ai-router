/**
 * Reasoning dialect for a downstream provider.
 *
 * - `friendli`   -> `chat_template_kwargs.thinking: boolean`
 * - `openrouter` -> `reasoning.enabled: boolean`
 */
export type ReasoningDialect = 'friendli' | 'openrouter';

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
 * NOTE on disabling: the AI SDK collapses a top-level `reasoning: 'none'` to an
 * absent `reasoning_effort` before this hook runs, so `reasoning: 'none'` is a
 * no-op (reasoning stays at the provider default). To explicitly disable, pass
 * `providerOptions.<provider>.reasoningEffort: 'none'`, which reaches here as
 * `reasoning_effort: 'none'`.
 */
export function translateReasoning(
  dialect: ReasoningDialect,
): (args: Record<string, any>) => Record<string, any> {
  return (args: Record<string, any>): Record<string, any> => {
    const body = { ...args }; // shallow clone; mutate-and-return
    const effort = body.reasoning_effort;

    if (effort == null) return body; // no reasoning requested -> leave untouched

    const enabled = !(effort === 'none' || effort === false);

    delete body.reasoning_effort;

    if (dialect === 'friendli') {
      body.chat_template_kwargs = { ...body.chat_template_kwargs, thinking: enabled };
    } else {
      body.reasoning = { ...body.reasoning, enabled };
    }

    return body;
  };
}
