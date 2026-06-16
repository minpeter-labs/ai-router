import {
  createReasoningTransform,
  reasoningMiddleware,
} from "../../core/reasoning";

export type PreserveReasoning = boolean | "auto";

const AUTO_PRESERVE_REASONING_MODELS = new Set(["glm-5.1", "kimi-k2.6"]);

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
      const waferEffort = toWaferReasoningEffort(effort);
      if (waferEffort != null) {
        body.reasoning_effort = waferEffort;
        return;
      }
      body.thinking = {
        ...getThinkingObject(body.thinking),
        type: "enabled",
      };
      return;
    }
    // On-without-level or off -> Wafer's boolean-style `thinking` toggle.
    body.thinking = {
      ...getThinkingObject(body.thinking),
      type: enabled ? "enabled" : "disabled",
    };
  }
);

export function createWaferRequestTransform(
  preserveReasoning: PreserveReasoning = false
): (args: Record<string, unknown>) => Record<string, unknown> {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const requestedPreserveReasoning =
      parsePreserveReasoning(args.preserveReasoning) ?? preserveReasoning;
    const { preserveReasoning: _omit, ...bodyWithoutAlias } = args;
    const body = waferReasoningTransform(bodyWithoutAlias);

    if (!shouldPreserveReasoning(body, requestedPreserveReasoning)) {
      return body;
    }

    return {
      ...body,
      preserve_thinking: true,
      thinking: {
        ...getThinkingObject(body.thinking),
        type: "enabled",
        keep: "all",
      },
    };
  };
}

/**
 * Keeps a call-level `reasoning` option (including `'none'`) alive down to
 * {@link waferReasoningTransform}.
 */
export const waferReasoningMiddleware = reasoningMiddleware("wafer");

function shouldPreserveReasoning(
  body: Record<string, unknown>,
  preserveReasoning: PreserveReasoning
): boolean {
  if (!isReasoningEnabled(body)) {
    return false;
  }

  if (preserveReasoning === true) {
    return true;
  }

  if (preserveReasoning === "auto") {
    return isAutoPreserveReasoningModel(body.model);
  }

  return false;
}

function isReasoningEnabled(body: Record<string, unknown>): boolean {
  const thinking = getThinkingObject(body.thinking);

  if (thinking?.type === "disabled") {
    return false;
  }

  if (body.reasoning_effort === "none" || body.reasoning_effort === false) {
    return false;
  }

  if (body.reasoning_effort != null) {
    return true;
  }

  if (thinking?.type === "enabled") {
    return true;
  }

  return body.enable_thinking === true;
}

function isAutoPreserveReasoningModel(model: unknown): boolean {
  return (
    typeof model === "string" &&
    AUTO_PRESERVE_REASONING_MODELS.has(model.toLowerCase())
  );
}

function parsePreserveReasoning(value: unknown): PreserveReasoning | undefined {
  if (value === true || value === false || value === "auto") {
    return value;
  }

  return;
}

function getThinkingObject(
  value: unknown
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function toWaferReasoningEffort(
  effort: string
): "low" | "medium" | "high" | "max" | undefined {
  switch (effort) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
    case "xhigh":
      return "max";
    default:
      return;
  }
}
