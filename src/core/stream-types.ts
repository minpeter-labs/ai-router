import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type { HealthProbeLease, HealthTransition } from "./health-store";
import type {
  ClassifyFailure,
  FailureClassification,
  OnRouterAttempt,
  OnRouterError,
  ProviderEntry,
  RouterOrderingToken,
} from "./types";

export interface ResolvedEntry {
  /** The user's original `ProviderEntry` (surfaced verbatim on `onError`). */
  entry: ProviderEntry;
  /** Index into the full (unfiltered) entries array. */
  fullIndex: number;
  /** The instantiated v4 model. */
  model: LanguageModelV4;
  probeLease?: HealthProbeLease;
}

export interface FallbackStreamArgs {
  acquireCandidate?: (candidate: ResolvedEntry) => number | undefined;
  attemptsStarted?: number;
  attemptTimeout?: number;
  backoff?: number;
  budgetFailureObserved?: boolean;
  budgetSuppressed?: boolean;
  candidateAvailable?: (candidate: ResolvedEntry) => boolean;
  candidateInFlight?: (candidate: ResolvedEntry) => number;
  /** Modality-filtered candidates, in order. */
  candidates: ResolvedEntry[];
  classifyFailure?: ClassifyFailure;
  concurrencyLimit?: (candidate: ResolvedEntry) => number | undefined;
  firstContentTimeout?: number;
  /** The already-awaited stream result of `candidates[startIndex]`. */
  firstResult: LanguageModelV4StreamResult;
  isBudgetFailure?: (failure: FailureClassification) => boolean;
  logicalId: string;
  maxAttempts?: number;
  nextOrderingToken?: () => RouterOrderingToken;
  /** Cooldown hook: commit the candidate at this filtered index as the survivor. */
  onAdvance?: (filteredIndex: number, hadFailure: boolean) => void;
  onAttempt?: OnRouterAttempt;
  onCandidateFailure?: (
    candidate: ResolvedEntry,
    failure: FailureClassification,
    attemptStartedAt: RouterOrderingToken,
    attemptStartedMonotonic: number
  ) => HealthTransition | undefined;
  onCandidateSuccess?: (
    candidate: ResolvedEntry,
    attemptStartedAt: RouterOrderingToken,
    attemptStartedMonotonic: number
  ) => HealthTransition | undefined;
  onError?: OnRouterError;
  onRequestOutcome?: (
    success: boolean,
    eligibleFailure: boolean,
    suppressed: boolean
  ) => void;
  options: LanguageModelV4CallOptions;
  prepareCandidate?: (candidate: ResolvedEntry) => boolean;
  /** Pre-open failures (candidates that threw before `firstResult`) for the aggregate. */
  priorErrors?: unknown[];
  releaseCandidate?: (candidate: ResolvedEntry) => void;
  releaseProbeCandidate?: (candidate: ResolvedEntry) => void;
  /** Retry even after content has streamed (may duplicate output). */
  retryAfterOutput: boolean;
  /** Retry classifier (already resolved). `true` => fall through to the next candidate. */
  shouldRetry: (error: unknown) => boolean;
  startAttemptStartedAt?: number;
  /** Index into `candidates` of the first attempt (the one `firstResult` came from). */
  startIndex: number;
  startInFlight?: number;
  startOrderingToken?: RouterOrderingToken;
  strictStreamValidation?: boolean;
  totalDeadline?: number;
  totalTimeout?: number;
  waitForCandidate?: (
    candidate: ResolvedEntry,
    signal?: AbortSignal
  ) => Promise<number | undefined>;
}
