import type {
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { addCapturedAbortListener } from "./abort-signal";
import { MAX_FILE_PAYLOAD_BYTES } from "./file-data";
import type { HealthTransition } from "./health-store";
import { copyFailureRecord } from "./retry";
import { discardLateStreamResult } from "./stream";
import { runSetupCandidateCleanup } from "./stream-candidate-cleanup";
import {
  captureOptionalHook,
  captureRequiredHook,
  isValidOrderingToken,
  tryCaptureOptionalHook,
} from "./stream-candidate-hooks";
import {
  snapshotPriorErrors,
  snapshotResolvedEntries,
} from "./stream-candidate-snapshot";
import {
  type FallbackPumpConfig,
  snapshotFallbackPumpConfig,
} from "./stream-config";
import { StreamLifecycleValidator } from "./stream-lifecycle-validator";
/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */
import {
  fallbackOrderingTokens,
  MAX_STREAM_JSON_CHARACTERS,
  MAX_STREAM_JSON_CONTAINERS,
  MAX_STREAM_METADATA_CHARACTERS,
  streamSignalAborted,
} from "./stream-part-fields";
import type { StreamJsonBudget } from "./stream-part-json";
import { type CapturedReader, CleanedStreamSetupError } from "./stream-reader";
import type { FallbackStreamArgs, ResolvedEntry } from "./stream-types";
import {
  abortControllerSafely,
  createAbortControllerSafely,
  monotonicNow,
} from "./timeout";
import type {
  FailureClassification,
  OnRouterAttempt,
  RouterOrderingToken,
} from "./types";

export abstract class FallbackPumpContext {
  protected committed = false; // has any candidate emitted output to the consumer?
  protected candidateCommitted = false; // has the live candidate emitted content / finished?
  protected finished = false; // a `finish` part was emitted; the stream is complete
  protected readonly metadataNodeCounts = new WeakMap<object, number>();
  protected readonly opaquePartTypes = new WeakMap<object, string>();
  protected readonly streamJsonBudget = {
    remainingFileBytes: MAX_FILE_PAYLOAD_BYTES,
    remaining: MAX_STREAM_JSON_CONTAINERS,
    remainingCharacters: MAX_STREAM_JSON_CHARACTERS,
    remainingMetadataCharacters: MAX_STREAM_METADATA_CHARACTERS,
  };
  protected candidateBudgetCheckpoint: StreamJsonBudget = {
    ...this.streamJsonBudget,
  };
  protected prelude: LanguageModelV4StreamPart[] = []; // buffered framing of the live candidate
  protected preludeMetadataNodes = 0;
  protected preludeTextChars = 0;
  protected cancelled = false;
  protected cancelReason: unknown;
  protected readonly errors: unknown[];
  protected activeReader: CapturedReader | null = null;
  protected resumeDemand?: () => void;

  protected readonly candidates: ResolvedEntry[];
  protected readonly config: FallbackPumpConfig;
  protected readonly acquireCandidate: FallbackStreamArgs["acquireCandidate"];
  protected readonly candidateAvailable: FallbackStreamArgs["candidateAvailable"];
  protected readonly candidateInFlight: FallbackStreamArgs["candidateInFlight"];
  protected readonly concurrencyLimit: FallbackStreamArgs["concurrencyLimit"];
  protected readonly prepareCandidate: FallbackStreamArgs["prepareCandidate"];
  protected readonly releaseCandidate: FallbackStreamArgs["releaseCandidate"];
  protected readonly releaseProbeCandidate: FallbackStreamArgs["releaseProbeCandidate"];
  protected readonly waitForCandidate: FallbackStreamArgs["waitForCandidate"];
  protected readonly classifyFailure: FallbackStreamArgs["classifyFailure"];
  protected readonly isBudgetFailure: FallbackStreamArgs["isBudgetFailure"];
  protected readonly nextOrderingToken: FallbackStreamArgs["nextOrderingToken"];
  protected readonly onAdvance: FallbackStreamArgs["onAdvance"];
  protected readonly onAttempt: FallbackStreamArgs["onAttempt"];
  protected readonly onCandidateFailure: FallbackStreamArgs["onCandidateFailure"];
  protected readonly onCandidateSuccess: FallbackStreamArgs["onCandidateSuccess"];
  protected readonly onError: FallbackStreamArgs["onError"];
  protected readonly onRequestOutcome: FallbackStreamArgs["onRequestOutcome"];
  protected readonly shouldRetry: FallbackStreamArgs["shouldRetry"];
  protected readonly setActive: (result: LanguageModelV4StreamResult) => void;
  protected readonly controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
  protected attemptsStarted: number;
  protected attemptStartedAt: number;
  protected attemptOrderingToken: RouterOrderingToken;
  protected validator = new StreamLifecycleValidator();
  protected activeInFlight?: number;
  protected activeIndex?: number;
  protected pendingFallbackIndex?: number;
  protected waitingIndex?: number;
  protected cancelledPendingIndex?: number;
  protected budgetFailureObserved: boolean;
  protected budgetSuppressed: boolean;
  protected deferSkippedAttemptEvents = false;
  protected readonly deferredSkippedAttemptEvents: Parameters<OnRouterAttempt>[0][] =
    [];
  protected requestOutcomeObserved = false;
  protected readonly operationAbort = createAbortControllerSafely();
  protected removeCallerAbort?: () => void;
  protected callerAbortObserved = false;
  protected callerAbortReason: unknown;

  protected abstract captureCallerAbortReason(
    signal: AbortSignal | undefined
  ): unknown;

  protected abstract cleanupAbortForwarding(): void;

  protected abstract emitAttempt(
    idx: number,
    outcome: "success" | "failure" | "cancelled",
    error?: unknown,
    failure?: FailureClassification,
    willRetry?: boolean,
    healthTransition?: HealthTransition,
    inFlight?: number
  ): void;

  protected abstract finishRequest(success: boolean): void;

  protected abstract pump(
    result: LanguageModelV4StreamResult,
    idx: number
  ): Promise<void>;

  protected abstract releaseActiveCandidate(): void;

  constructor(
    args: FallbackStreamArgs,
    setActive: (result: LanguageModelV4StreamResult) => void,
    controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
    firstResult: LanguageModelV4StreamResult
  ) {
    const releaseCandidate = tryCaptureOptionalHook<
      FallbackStreamArgs["releaseCandidate"]
    >(args, "releaseCandidate");
    const releaseProbeCandidate = tryCaptureOptionalHook<
      FallbackStreamArgs["releaseProbeCandidate"]
    >(args, "releaseProbeCandidate");
    this.releaseCandidate = releaseCandidate.value;
    this.releaseProbeCandidate = releaseProbeCandidate.value;
    try {
      if (releaseCandidate.error !== undefined) {
        throw releaseCandidate.error;
      }
      if (releaseProbeCandidate.error !== undefined) {
        throw releaseProbeCandidate.error;
      }
      this.acquireCandidate = captureOptionalHook(args, "acquireCandidate");
      this.candidateAvailable = captureOptionalHook(args, "candidateAvailable");
      this.candidateInFlight = captureOptionalHook(args, "candidateInFlight");
      this.concurrencyLimit = captureOptionalHook(args, "concurrencyLimit");
      this.prepareCandidate = captureOptionalHook(args, "prepareCandidate");
      this.waitForCandidate = captureOptionalHook(args, "waitForCandidate");
      this.classifyFailure = captureOptionalHook(args, "classifyFailure");
      this.isBudgetFailure = captureOptionalHook(args, "isBudgetFailure");
      this.nextOrderingToken = captureOptionalHook(args, "nextOrderingToken");
      this.onAdvance = captureOptionalHook(args, "onAdvance");
      this.onAttempt = captureOptionalHook(args, "onAttempt");
      this.onCandidateFailure = captureOptionalHook(args, "onCandidateFailure");
      this.onCandidateSuccess = captureOptionalHook(args, "onCandidateSuccess");
      this.onError = captureOptionalHook(args, "onError");
      this.onRequestOutcome = captureOptionalHook(args, "onRequestOutcome");
      this.shouldRetry = captureRequiredHook(args, "shouldRetry");
      this.candidates = snapshotResolvedEntries(args.candidates);
      this.config = snapshotFallbackPumpConfig(
        args,
        this.candidates.length,
        firstResult
      );
    } catch (error) {
      try {
        discardLateStreamResult(firstResult);
      } catch {
        // Hostile result access cannot suppress the available lease cleanup.
      }
      try {
        runSetupCandidateCleanup(
          args,
          this.releaseCandidate,
          this.releaseProbeCandidate
        );
      } catch {
        // Malformed candidate access leaves no additional safe cleanup path.
      }
      throw new CleanedStreamSetupError(error);
    }
    this.setActive = setActive;
    this.controller = controller;
    this.errors = snapshotPriorErrors(this.config.priorErrors);
    if (this.config.priorErrors !== undefined) {
      copyFailureRecord(this.config.priorErrors, this.errors);
    }
    this.attemptsStarted = this.config.attemptsStarted ?? 1;
    this.attemptStartedAt = this.config.startAttemptStartedAt ?? monotonicNow();
    this.activeInFlight = this.config.startInFlight;
    this.activeIndex = this.config.startIndex;
    this.budgetFailureObserved = this.config.budgetFailureObserved ?? false;
    this.budgetSuppressed = this.config.budgetSuppressed ?? false;
    this.attemptOrderingToken = isValidOrderingToken(
      this.config.startOrderingToken
    )
      ? this.config.startOrderingToken
      : fallbackOrderingTokens.next();
    const callerSignal = this.config.options.abortSignal;
    if (streamSignalAborted(callerSignal)) {
      abortControllerSafely(
        this.operationAbort,
        this.captureCallerAbortReason(callerSignal)
      );
    } else if (callerSignal !== undefined) {
      const onAbort = () => {
        if (streamSignalAborted(this.operationAbort.signal)) {
          return;
        }
        abortControllerSafely(
          this.operationAbort,
          this.captureCallerAbortReason(callerSignal)
        );
      };
      try {
        this.removeCallerAbort = addCapturedAbortListener(
          callerSignal,
          onAbort
        );
        if (streamSignalAborted(callerSignal)) {
          onAbort();
        }
      } catch (error) {
        abortControllerSafely(this.operationAbort, error);
      }
    }
  }
}
