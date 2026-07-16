import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import { RouterHealthUnavailableError } from "./health-store";
import { detectModalities, supportsAll } from "./modality";
import { InvalidProviderModelError } from "./router-generate-validator";
import { snapshotLanguageModelV4 } from "./router-model-options";
import {
  sanitizeSupportedUrls,
  settleSupportedUrls,
} from "./router-supported-urls";
import { captureGenuinePromise } from "./runtime-types";
import type { ResolvedEntry } from "./stream";
import type {
  RouterAdmissionSnapshot,
  RouterHealthSnapshot,
  RouterRetryBudgetSnapshot,
} from "./types";

/**
 * A candidate entry normalized to a single internal shape, regardless of which
 * of the three accepted `ProviderEntry` forms the user wrote.
 */

import { RouterModelConfig } from "./router-model-config";

export abstract class RouterModelState extends RouterModelConfig {
  protected computeSupportedUrls():
    | Promise<Record<string, RegExp[]>>
    | Record<string, RegExp[]> {
    // With multiple candidates the router cannot know which one will serve the
    // request, so it conservatively reports NO native URL support — the SDK then
    // downloads + inlines every URL, which any candidate accepts. A lone
    // candidate can safely report its own support. Either way, a broken / non-v4
    // first entry must not abort call setup (read before any fallback runs).
    if (this.normalized.length !== 1) {
      return {};
    }
    try {
      const supported = this.instantiate(0).supportedUrls;
      if (
        supported !== null &&
        (typeof supported === "object" || typeof supported === "function")
      ) {
        const promise = captureGenuinePromise(supported);
        if (promise !== undefined) {
          return settleSupportedUrls(promise);
        }
        return sanitizeSupportedUrls(supported);
      }
      return sanitizeSupportedUrls(supported);
    } catch {
      return {};
    }
  }

  healthSnapshot(): RouterHealthSnapshot[] {
    return this.health.snapshot();
  }

  admissionSnapshot(): RouterAdmissionSnapshot[] {
    return this.normalized.map((_, index) => ({
      ...this.admission.snapshot(index),
      logicalId: this.modelId,
    }));
  }

  retryBudgetSnapshot(): RouterRetryBudgetSnapshot | undefined {
    const snapshot = this.retryBudget?.snapshot();
    return snapshot === undefined
      ? undefined
      : { ...snapshot, logicalId: this.modelId };
  }

  /**
   * Commit a survivor into cooldown state, but only when reaching it actually
   * involved an earlier candidate failing (`hadFailure`), or when it is the
   * primary recovering (`fullIndex === 0`). A candidate reached merely because
   * earlier entries were modality-filtered out must NOT become sticky —
   * otherwise a later request of a different modality would skip a perfectly
   * healthy higher-priority primary. No-op when cooldown is disabled.
   */
  protected commitSurvivor(fullIndex: number, hadFailure: boolean): void {
    if (hadFailure || fullIndex === 0) {
      this.cooldown?.advanceTo(fullIndex);
    }
  }

  protected assertHasCandidate(candidates: ResolvedEntry[]): void {
    if (candidates.length === 0) {
      throw new Error(
        `ai-router: no candidate for "${this.modelId}" supports the requested input modalities`
      );
    }
  }

  /** Lazily instantiate (and cache) the model for a candidate index. */
  protected instantiate(index: number): LanguageModelV4 {
    // Cached models are always defined objects, so a present entry short-circuits
    // without a second Map lookup (and never re-creates a candidate).
    const cached = this.modelCache.get(index);
    if (cached !== undefined) {
      return cached;
    }
    const cachedError = this.modelErrors.get(index);
    if (cachedError !== undefined) {
      throw cachedError;
    }

    const entry = this.normalized[index];
    const model = entry.raw();
    // Fail fast — outside the fallback loop — if a factory or instance entry did
    // not yield a v4 language model (a bare model-id string, or an older spec).
    // Otherwise it would crash deep inside the routed call and be swallowed into
    // fallback as an opaque error.
    const stableModel = snapshotLanguageModelV4(model);
    if (stableModel === undefined) {
      const error = new InvalidProviderModelError(
        entry.label === undefined
          ? `ai-router: entry for "${this.modelId}" did not provide a v4 LanguageModel`
          : `ai-router: provider for "${this.modelId}" (model "${entry.label}") did not return a v4 LanguageModel`
      );
      this.modelErrors.set(index, error);
      throw error;
    }
    this.modelCache.set(index, stableModel);
    return stableModel;
  }

  /**
   * Filter entries by the prompt's required modalities and order them for this
   * request. With sticky cooldown, the active survivor is promoted to the head
   * instead of becoming a start offset, so every other compatible candidate
   * remains reachable if that survivor fails.
   */
  protected selectCandidates(
    options: LanguageModelV4CallOptions,
    phase: "generate" | "stream-open"
  ): {
    candidates: ResolvedEntry[];
    startIndex: number;
  } {
    const required = detectModalities(options.prompt);
    const candidates: ResolvedEntry[] = [];
    const coolingCandidates: ResolvedEntry[] = [];
    const router = this;
    for (let i = 0; i < this.normalized.length; i++) {
      if (supportsAll(this.normalized[i].supports, required)) {
        const index = i;
        const resolved: ResolvedEntry = {
          entry: this.normalized[i].original,
          // Instantiate lazily, on first access, so a later candidate whose
          // factory throws (or yields a non-v4 model) is treated as a normal
          // candidate failure (classified + fallen through) rather than aborting
          // the whole request before a healthy higher-priority candidate runs.
          get model() {
            return router.instantiate(index);
          },
          fullIndex: i,
        };
        if (
          this.healthEnabled &&
          !this.health.available(
            i,
            this.normalized[i].healthKey,
            this.normalized[i].providerFamily
          )
        ) {
          coolingCandidates.push(resolved);
        } else {
          candidates.push(resolved);
        }
      }
    }

    this.emitSkipped(coolingCandidates, phase, "cooldown");
    if (candidates.length === 0 && coolingCandidates.length > 0) {
      throw new RouterHealthUnavailableError(this.modelId);
    }

    if (this.cooldown) {
      this.cooldown.checkAndReset();
      const active = this.cooldown.current();
      // Honor the sticky survivor ONLY when it is itself present in this request's
      // modality-filtered set. If it was filtered out, re-probe from the top
      // rather than skipping forward to a later candidate (which would silently
      // bypass a healthy higher-priority candidate for this modality).
      const pos = candidates.findIndex(
        (candidate) => candidate.fullIndex === active
      );
      if (pos > 0) {
        const [sticky] = candidates.splice(pos, 1);
        if (sticky !== undefined) {
          candidates.unshift(sticky);
        }
      }
      // Keep the sticky survivor (or the first modality-compatible candidate
      // when it is absent) first. Selection policies only balance the fallback
      // tail and therefore cannot bypass the cooldown decision.
      this.applySelection(candidates, 1);
    } else {
      this.applySelection(candidates);
    }
    return { candidates, startIndex: 0 };
  }

  protected applySelection(candidates: ResolvedEntry[], from = 0): void {
    if (from === 0) {
      this.admission.reorder(candidates, this.selection);
      return;
    }
    const tail = candidates.slice(from);
    this.admission.reorder(tail, this.selection);
    candidates.splice(from, tail.length, ...tail);
  }
}
