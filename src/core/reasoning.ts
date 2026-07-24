import type { LanguageModelMiddleware } from "ai";
import { boundedEnumerableOwnKeys } from "./http-headers";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";

const MAX_REASONING_BODY_FIELDS = 10_000;

export function snapshotReasoningRequestBody(
  value: unknown,
  omittedKeys: readonly string[] = []
): Record<string, unknown> {
  if (consumeGenuinePromise(value)) {
    throw new TypeError("reasoning request body must be synchronous");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("reasoning request body must be an object");
  }
  const keys = boundedEnumerableOwnKeys(value, MAX_REASONING_BODY_FIELDS);
  if (keys === undefined) {
    throw new TypeError(
      `reasoning request body must contain at most ${MAX_REASONING_BODY_FIELDS} fields`
    );
  }
  consumeOwnDataPromiseFields(value, keys);
  const entries: Array<readonly [string, unknown]> = [];
  let asyncField = false;
  for (const key of keys) {
    const item = Reflect.get(value, key);
    if (consumeGenuinePromise(item)) {
      asyncField = true;
    }
    entries.push([key, item]);
  }
  if (asyncField) {
    throw new TypeError("reasoning request body fields must be synchronous");
  }
  const omitted = new Set(omittedKeys);
  const snapshot: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (omitted.has(key)) {
      continue;
    }
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return snapshot;
}

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
  if (
    consumeGenuinePromise(applyReasoning) ||
    typeof applyReasoning !== "function"
  ) {
    throw new TypeError("applyReasoning must be a synchronous function");
  }
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const body = snapshotReasoningRequestBody(args);
    const effort = body.reasoning_effort;

    // No reasoning requested -> return an untouched clone (keeps the key if set).
    if (effort == null) {
      return body;
    }

    const bodyWithoutEffort = snapshotReasoningRequestBody(body, [
      "reasoning_effort",
    ]);
    const result = applyReasoning(
      bodyWithoutEffort,
      !(effort === "none" || effort === false),
      effort
    );
    if (consumeGenuinePromise(result)) {
      throw new TypeError("applyReasoning must return synchronously");
    }
    return bodyWithoutEffort;
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
  if (
    consumeGenuinePromise(name) ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 256
  ) {
    throw new TypeError(
      "reasoning provider name must be synchronous and bounded"
    );
  }
  return {
    transformParams: (options) => {
      const hookOptions = snapshotReasoningRequestBody(options);
      const params = hookOptions.params as typeof options.params;
      if (typeof params !== "object" || params === null) {
        throw new TypeError("reasoning middleware params must be an object");
      }
      const capturedParams = snapshotReasoningRequestBody(params);
      const reasoning = capturedParams.reasoning;
      // Leave the provider default in place when nothing actionable was asked.
      if (reasoning == null || reasoning === "provider-default") {
        return Promise.resolve(params);
      }

      const providerOptions =
        capturedParams.providerOptions === undefined
          ? {}
          : snapshotReasoningRequestBody(capturedParams.providerOptions);
      const providerSettings =
        providerOptions[name] === undefined
          ? {}
          : snapshotReasoningRequestBody(providerOptions[name]);
      // An explicit reasoningEffort wins; don't clobber it.
      if (providerSettings.reasoningEffort != null) {
        return Promise.resolve(params);
      }

      return Promise.resolve({
        ...capturedParams,
        providerOptions: {
          ...providerOptions,
          [name]: { ...providerSettings, reasoningEffort: reasoning },
        },
      } as typeof params);
    },
  };
}
