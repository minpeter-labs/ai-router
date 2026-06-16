import {
  createReasoningTransform,
  reasoningMiddleware,
} from "../../core/reasoning";

/**
 * Wafer reasoning dialect: `thinking.type` (`'enabled'` | `'disabled'`).
 *
 * Wafer toggles reasoning with an object field rather than a boolean:
 *  - reasoning on  -> `thinking: { type: 'enabled' }`
 *  - reasoning off -> `thinking: { type: 'disabled' }`
 */
export const waferReasoningTransform = createReasoningTransform(
  (body, enabled) => {
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
