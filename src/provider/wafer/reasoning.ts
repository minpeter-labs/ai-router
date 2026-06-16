import {
  createReasoningTransform,
  reasoningMiddleware,
} from "../../core/reasoning";

/**
 * Wafer reasoning dialect.
 *
 * Wafer natively accepts a granular `reasoning_effort` (`none | low | medium |
 * high | max`), so — unlike the binary friendli/openrouter dialects — an
 * explicit level is forwarded verbatim instead of being collapsed to on/off:
 *  - a level string (e.g. `'high'`, or `'max'` via providerOptions)
 *      -> `reasoning_effort: <level>`
 *  - reasoning on without a level (`reasoning_effort: true`)
 *      -> `thinking: { type: 'enabled' }`
 *  - reasoning off (`'none'` / `false`)
 *      -> `thinking: { type: 'disabled' }`
 *
 * (`max` is Wafer-specific and not in the AI SDK's level set, so it is reachable
 * via `providerOptions.wafer.reasoningEffort: 'max'`.)
 */
export const waferReasoningTransform = createReasoningTransform(
  (body, enabled, effort) => {
    // Enabled with an explicit level -> forward the granular effort natively.
    // (`effort` is never `'none'` here: that classifies as disabled.)
    if (enabled && typeof effort === "string") {
      body.reasoning_effort = effort;
      return;
    }
    // On-without-level or off -> Wafer's boolean-style `thinking` toggle.
    body.thinking = {
      ...(body.thinking as Record<string, unknown> | undefined),
      type: enabled ? "enabled" : "disabled",
    };
  }
);

/**
 * Keeps a call-level `reasoning` option (including `'none'`) alive down to
 * {@link waferReasoningTransform}.
 */
export const waferReasoningMiddleware = reasoningMiddleware("wafer");
