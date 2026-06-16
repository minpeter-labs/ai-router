import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";

import { waferReasoningMiddleware, waferReasoningTransform } from "./reasoning";

const DEFAULT_BASE_URL = "https://pass.wafer.ai/v1";

const ZDR_HEADER = "Wafer-ZDR";

export interface CreateWaferSettings
  extends Omit<
    OpenAICompatibleProviderSettings,
    "name" | "baseURL" | "transformRequestBody"
  > {
  /** Wafer API key. Defaults to `process.env.WAFER_API_KEY`. */
  apiKey?: string;
  /** Override the base URL. Defaults to the Wafer Pass v1 endpoint. */
  baseURL?: string;
  /**
   * Request Zero Data Retention. When `true`, every request carries
   * `Wafer-ZDR: required`, telling Wafer to reject the request unless it can
   * guarantee prompts and completions are never written to durable storage.
   *
   * Off by default: the `required` value fails the request closed if the
   * account/plan is not ZDR-entitled, so it is opt-in rather than always-on.
   * Wafer bills per token with no documented ZDR surcharge, so enabling it does
   * not change request cost on an entitled account.
   */
  zdr?: boolean;
}

/**
 * Wafer provider built on `@ai-sdk/openai-compatible`.
 *
 * Wafer accepts a granular `reasoning_effort`, so the `reasoning` option keeps
 * its level instead of collapsing to on/off:
 *  - `reasoning: 'low' | 'medium' | 'high'` -> `reasoning_effort: <level>`
 *  - `reasoning: 'none'`                     -> `thinking.type: 'disabled'`
 *  - Wafer's extra `'max'` level (not in the AI SDK set) is reachable via
 *    `providerOptions.wafer.reasoningEffort: 'max'`.
 *
 * `MiniMax-M3` returns reasoning inline as `<think>…</think>` rather than in a
 * `reasoning_content` field; it is extracted into a reasoning part automatically.
 *
 * @example
 * const wafer = createWafer();
 * await streamText({ model: wafer('GLM-5.1'), reasoning: 'high', prompt: '...' });
 *
 * @example
 * // Opt into Zero Data Retention (sends `Wafer-ZDR: required`).
 * const wafer = createWafer({ zdr: true });
 */
export function createWafer(
  settings: CreateWaferSettings = {}
): (modelId: string) => LanguageModelV4 {
  const { apiKey, baseURL, zdr, headers, ...rest } = settings;
  const provider = createOpenAICompatible({
    ...rest,
    name: "wafer",
    baseURL: baseURL ?? DEFAULT_BASE_URL,
    apiKey: apiKey ?? process.env.WAFER_API_KEY,
    headers: zdr ? { ...headers, [ZDR_HEADER]: "required" } : headers,
    transformRequestBody: waferReasoningTransform,
  });
  return (modelId: string) =>
    wrapLanguageModel({
      model: provider(modelId),
      middleware: [
        // Wrap each model so a top-level `reasoning: 'none'` survives down to the
        // body (the AI SDK otherwise drops it before `transformRequestBody` runs).
        waferReasoningMiddleware,
        // Most reasoning models return reasoning in a separate `reasoning_content`
        // field (handled by the base layer), but `MiniMax-M3` instead returns it
        // inline in `content` as `<think>…</think>`. Surface that as reasoning. A
        // no-op for the others — without a `<think>` tag the text passes through.
        extractReasoningMiddleware({ tagName: "think" }),
      ],
    });
}
