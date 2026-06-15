import {
  createReasoningTransform,
  reasoningMiddleware,
} from "../../core/reasoning";

/**
 * Friendli reasoning dialect: `chat_template_kwargs.{thinking, enable_thinking}`.
 *
 * Friendli's toggle is model-dependent — most models read `thinking`, but some
 * (e.g. Gemma 4) read `enable_thinking`. We write both; a model ignores the
 * field it doesn't recognize.
 */
export const friendliReasoningTransform = createReasoningTransform(
  (body, enabled) => {
    body.chat_template_kwargs = {
      ...(body.chat_template_kwargs as Record<string, unknown> | undefined),
      thinking: enabled,
      enable_thinking: enabled,
    };
  }
);

/**
 * Keeps a call-level `reasoning` option (including `'none'`) alive down to
 * {@link friendliReasoningTransform}.
 */
export const friendliReasoningMiddleware = reasoningMiddleware("friendli");
