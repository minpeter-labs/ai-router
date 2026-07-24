import {
  createReasoningTransform,
  reasoningMiddleware,
} from "../../core/reasoning";

/** OpenRouter reasoning dialect: `reasoning.enabled` (boolean). */
export const openrouterReasoningTransform = createReasoningTransform(
  (body, enabled) => {
    body.reasoning = {
      ...(body.reasoning as Record<string, unknown> | undefined),
      enabled,
    };
  }
);

/**
 * Keeps a call-level `reasoning` option (including `'none'`) alive down to
 * {@link openrouterReasoningTransform}.
 */
export const openrouterReasoningMiddleware = reasoningMiddleware("openrouter");
