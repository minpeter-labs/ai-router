import type { LanguageModelV4 } from "@ai-sdk/provider";

import { AdmissionController } from "./admission";
import type { AdmissionRegistry } from "./admission-utils";
import type { RetryBudget } from "./budget";
import { CandidateHealthState } from "./candidate-health";
import { CooldownState, resolveCooldown } from "./cooldown";
import { defaultClassifyFailure } from "./failure";
import type { OrderingTokenSource } from "./ordering";
import { resolveShouldRetry } from "./retry";
import { type NormalizedEntry, normalizeEntry } from "./router-entry";
import type { InvalidProviderModelError } from "./router-generate-validator";
import {
  createRetryBudget,
  resolveHealthNamespace,
  resolveSharedHealthNamespace,
  validateEntryConfiguration,
  validateSharedAdmission,
} from "./router-options";
import { sanitizeSupportedUrls } from "./router-supported-urls";
import type { ResolvedEntry } from "./stream";
import { durationMs } from "./timeout";
import type {
  ClassifyFailure,
  CreateRouterOptions,
  OnRouterAttempt,
  OnRouterError,
  ProviderEntry,
  RouterHealthStore,
  ShouldRetryThisError,
  ValidateGenerateResult,
} from "./types";

/**
 * A candidate entry normalized to a single internal shape, regardless of which
 * of the three accepted `ProviderEntry` forms the user wrote.
 */

export abstract class RouterModelConfig {
  protected abstract computeSupportedUrls():
    | Promise<Record<string, RegExp[]>>
    | Record<string, RegExp[]>;

  readonly specificationVersion = "v4" as const;
  readonly provider = "router";
  readonly modelId: string;

  protected readonly normalized: NormalizedEntry[];
  protected readonly onError?: OnRouterError;
  protected readonly shouldRetry: ShouldRetryThisError;
  protected readonly retryAfterOutput: boolean;
  protected readonly cooldown?: CooldownState;
  protected readonly health: CandidateHealthState;
  protected readonly healthEnabled: boolean;
  protected readonly classifyFailure: ClassifyFailure;
  protected readonly hasCustomClassifier: boolean;
  protected readonly hasCustomRetry: boolean;
  protected readonly attemptTimeout?: number;
  protected readonly concurrencyWaitTimeout?: number;
  protected readonly backoff?: number;
  protected readonly firstContentTimeout?: number;
  protected readonly totalTimeout?: number;
  protected readonly maxAttempts: number;
  protected readonly onAttempt?: OnRouterAttempt;
  protected readonly validateResult?: ValidateGenerateResult;
  protected readonly strictStreamValidation: boolean;
  protected readonly retryBudget?: RetryBudget;
  protected readonly admission: AdmissionController;
  protected readonly ordering: OrderingTokenSource;
  protected readonly selection: "least-inflight" | "ordered" | "round-robin";

  /** Cache of instantiated models, keyed by candidate index. */
  protected readonly modelCache = new Map<number, LanguageModelV4>();
  /** Permanent invalid-model results are cached; transient factory throws are not. */
  protected readonly modelErrors = new Map<number, InvalidProviderModelError>();
  /** Memoized conservative `supportedUrls` (computed once per instance). */
  protected supportedUrlsCache: Record<string, RegExp[]> = {};
  protected supportedUrlsPromise?: Promise<Record<string, RegExp[]>>;
  protected supportedUrlsComputed = false;

  protected abstract emitSkipped(
    candidates: ResolvedEntry[],
    phase: "generate" | "stream-open",
    reason: "concurrency" | "cooldown" | "max-attempts"
  ): void;

  constructor(
    logicalId: string,
    entries: ProviderEntry[],
    options: CreateRouterOptions,
    admissionRegistry: AdmissionRegistry,
    healthStore: RouterHealthStore,
    ordering: OrderingTokenSource
  ) {
    this.modelId = logicalId;
    this.ordering = ordering;
    const fallback = options.fallback;
    this.health = new CandidateHealthState(
      resolveHealthNamespace(logicalId, fallback?.healthNamespace),
      healthStore,
      Date.now,
      resolveSharedHealthNamespace(logicalId, fallback?.healthNamespace)
    );
    this.normalized = entries.map(normalizeEntry);
    for (const entry of this.normalized) {
      validateEntryConfiguration(entry);
      if (
        entry.maxConcurrency !== undefined &&
        (!Number.isSafeInteger(entry.maxConcurrency) ||
          entry.maxConcurrency < 1)
      ) {
        throw new Error("ai-router: maxConcurrency must be a positive integer");
      }
    }
    for (const [index, entry] of this.normalized.entries()) {
      this.health.register(index, entry.healthKey, entry.providerFamily);
    }
    validateSharedAdmission(this.normalized);
    this.onError = options.onError;
    this.onAttempt = options.onAttempt;
    this.shouldRetry = resolveShouldRetry(fallback?.shouldRetry);
    this.classifyFailure = fallback?.classifyFailure ?? defaultClassifyFailure;
    this.hasCustomClassifier = fallback?.classifyFailure !== undefined;
    this.hasCustomRetry = fallback?.shouldRetry !== undefined;
    this.retryAfterOutput = fallback?.retryAfterOutput ?? false;
    this.attemptTimeout = durationMs(fallback?.attemptTimeout);
    this.concurrencyWaitTimeout = durationMs(fallback?.concurrencyWaitTimeout);
    this.admission = new AdmissionController(
      this.normalized,
      this.concurrencyWaitTimeout,
      resolveHealthNamespace(logicalId, fallback?.healthNamespace),
      admissionRegistry
    );
    this.backoff =
      fallback?.backoff === false ? undefined : durationMs(fallback?.backoff);
    this.firstContentTimeout = durationMs(fallback?.firstContentTimeout);
    this.totalTimeout = durationMs(fallback?.totalTimeout);
    this.maxAttempts = Math.max(
      1,
      Math.floor(fallback?.maxAttempts ?? entries.length)
    );
    if (
      fallback?.maxAttempts !== undefined &&
      (!(
        Number.isFinite(fallback.maxAttempts) &&
        Number.isSafeInteger(fallback.maxAttempts)
      ) ||
        fallback.maxAttempts < 1)
    ) {
      throw new Error(
        "ai-router: maxAttempts must be a positive finite number"
      );
    }
    this.retryBudget = createRetryBudget(fallback?.retryBudget);
    const selection = fallback?.selection ?? "ordered";
    if (
      selection !== "ordered" &&
      selection !== "least-inflight" &&
      selection !== "round-robin"
    ) {
      throw new Error(
        'ai-router: selection must be "ordered", "least-inflight", or "round-robin"'
      );
    }
    this.selection = selection;
    this.validateResult = fallback?.validateResult;
    this.strictStreamValidation = fallback?.strictStreamValidation ?? false;
    const cfg = resolveCooldown(fallback?.cooldown);
    this.cooldown = cfg ? new CooldownState(cfg) : undefined;
    this.healthEnabled = fallback?.health ?? cfg !== undefined;
  }

  /**
   * The set of URLs the router can pass through un-downloaded. The AI SDK reads
   * this ONCE during call setup to decide whether to download+inline a URL or
   * forward it raw — but it cannot know which candidate will actually serve the
   * request. So we report only the support COMMON to every candidate: a URL is
   * passed through only if all candidates handle it natively; otherwise the SDK
   * inlines it (which any candidate accepts). Computed once and memoized.
   */
  get supportedUrls(): LanguageModelV4["supportedUrls"] {
    if (!this.supportedUrlsComputed) {
      const computed = this.computeSupportedUrls();
      if (computed instanceof Promise) {
        this.supportedUrlsPromise = computed;
      } else {
        this.supportedUrlsCache = computed;
      }
      this.supportedUrlsComputed = true;
    }
    if (this.supportedUrlsPromise !== undefined) {
      return this.supportedUrlsPromise.then(sanitizeSupportedUrls, () => ({}));
    }
    return sanitizeSupportedUrls(this.supportedUrlsCache);
  }
}
