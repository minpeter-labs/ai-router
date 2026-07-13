import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import {
  snapshotAdaptiveConcurrency,
  snapshotLanguageModelV4,
  snapshotSupports,
} from "./router-model-options";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";
import type {
  Modality,
  ProviderEntry,
  ProviderEntryFactory,
  ProviderEntryInstance,
} from "./types";

export interface NormalizedEntry {
  adaptiveConcurrency?: boolean | import("./types").AdaptiveConcurrencyConfig;
  healthKey?: string;
  /** Model id for the fail-fast error message (factory form only). */
  label?: string;
  maxConcurrency?: number;
  /** The user's original entry — surfaced verbatim on `onError`. */
  original: ProviderEntry;
  providerFamily?: string;
  /** Produce the raw model (calls the factory, or returns the captured instance). */
  raw: () => LanguageModel;
  /** Declared modalities, or `undefined` for a universal (catch-all) candidate. */
  supports?: Modality[];
}

export function assertSynchronousEntryFields(values: readonly unknown[]): void {
  let asyncField = false;
  for (const value of values) {
    if (consumeGenuinePromise(value)) {
      asyncField = true;
    }
  }
  if (asyncField) {
    throw new Error("ai-router: provider entry fields must be synchronous");
  }
}

/** Collapse any of the three `ProviderEntry` shapes into a {@link NormalizedEntry}. */
export function normalizeEntry(entry: ProviderEntry): NormalizedEntry {
  if (typeof entry !== "object" || entry === null) {
    throw new Error("ai-router: each provider entry must be an object");
  }
  consumeOwnDataPromiseFields(entry, [
    "adaptiveConcurrency",
    "healthKey",
    "maxConcurrency",
    "model",
    "provider",
    "providerFamily",
    "supports",
  ]);
  // Wrapper entries are identified without evaluating either their `model`
  // getter or unrelated bare-model fields. This keeps extension getters out of
  // the alternate shape's validation path.
  if (!Reflect.has(entry, "model")) {
    const bareModel = snapshotLanguageModelV4(entry);
    if (bareModel !== undefined) {
      return { original: entry, raw: () => bareModel };
    }
    throw new Error("ai-router: each bare provider entry must be a v4 model");
  }
  // (2) Instance-object form: `{ model: <v4 model>, supports? }`.
  const candidate = entry as ProviderEntryFactory | ProviderEntryInstance;
  const candidateModel = Reflect.get(candidate, "model");
  if (consumeGenuinePromise(candidateModel)) {
    throw new Error("ai-router: provider entry model must be synchronous");
  }
  if (candidateModel !== null && typeof candidateModel === "object") {
    const instance = candidate as ProviderEntryInstance;
    const model = candidateModel as LanguageModelV4;
    const adaptiveConcurrency = instance.adaptiveConcurrency;
    const healthKey = instance.healthKey;
    const maxConcurrency = instance.maxConcurrency;
    const supports = instance.supports;
    const providerFamily = instance.providerFamily;
    assertSynchronousEntryFields([
      adaptiveConcurrency,
      healthKey,
      maxConcurrency,
      supports,
      providerFamily,
    ]);
    return {
      adaptiveConcurrency: snapshotAdaptiveConcurrency(adaptiveConcurrency),
      healthKey,
      maxConcurrency,
      supports: snapshotSupports(supports),
      original: entry,
      providerFamily,
      raw: () => model,
    };
  }
  // (3) Factory form: `{ provider, model: string, supports? }`.
  const factory = candidate as ProviderEntryFactory;
  const provider = factory.provider;
  const adaptiveConcurrency = factory.adaptiveConcurrency;
  const healthKey = factory.healthKey;
  const maxConcurrency = factory.maxConcurrency;
  const supports = factory.supports;
  const providerFamily = factory.providerFamily;
  assertSynchronousEntryFields([
    provider,
    adaptiveConcurrency,
    healthKey,
    maxConcurrency,
    supports,
    providerFamily,
  ]);
  if (typeof provider !== "function" || typeof candidateModel !== "string") {
    throw new Error(
      "ai-router: a factory entry requires a `provider` function and a string `model`"
    );
  }
  const model = candidateModel;
  return {
    adaptiveConcurrency: snapshotAdaptiveConcurrency(adaptiveConcurrency),
    healthKey,
    maxConcurrency,
    supports: snapshotSupports(supports),
    original: entry,
    providerFamily,
    label: model,
    raw: () => Reflect.apply(provider, factory, [model]),
  };
}

/**
 * A delegating `LanguageModelV4` for one logical id.
 *
 * For every request it:
 *  1. Detects the input modalities from the prompt.
 *  2. Keeps the candidate entries whose `supports` covers them, in order.
 *  3. Tries each candidate; on failure it classifies the error (retry vs stop),
 *     calls `onError`, and falls through to the next one when retryable.
 *  4. On `doStream`, wraps the live stream so a mid-stream failure also falls
 *     back transparently (before any content has been emitted).
 *  5. Surfaces the original error for a single failure, or an `AggregateError`
 *     of all candidate errors when several fail.
 *
 * It forwards an attempt-isolated copy of the V4 call options so one provider
 * cannot mutate the prompt or policy observed by later fallback candidates.
 */
