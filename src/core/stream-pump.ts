import type {
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { consumeGenuinePromise } from "./runtime-types";
import { consumeFailureClassificationPromiseMutations } from "./stream-candidate-snapshot";
import { StreamLifecycleValidator } from "./stream-lifecycle-validator";
import { FallbackPumpParts } from "./stream-pump-parts";
import {
  type CapturedReader,
  cancelAndReleaseReaderQuietly,
  cancelQuietly,
  captureReader,
  EmptyModelStreamError,
  IncompleteModelStreamError,
  InvalidModelStreamError,
  releaseReaderLockQuietly,
  StreamPreludeOverflowError,
  snapshotReadResult,
} from "./stream-reader";
import { monotonicNow, RouterTimeoutError } from "./timeout";
import { withTimeout } from "./timeout-operation";
import type { FailureClassification } from "./types";

export class FallbackPump extends FallbackPumpParts {
  protected forwardPart(
    value: LanguageModelV4StreamPart,
    idx: number,
    advanced: boolean
  ): boolean {
    if (this.shouldBufferPart(value)) {
      if (this.candidateCommitted) {
        this.safeEnqueue(value); // post-commit framing passes through
      } else {
        this.prelude.push(value); // pre-commit framing is buffered
        this.preludeMetadataNodes += this.bufferedMetadataNodes(value);
        this.preludeTextChars += this.bufferedTextLength(value);
      }
      return advanced;
    }
    // A commit part: real content, or a `finish` terminal.
    if (!this.candidateCommitted) {
      this.candidateCommitted = true;
      this.committed = true;
      this.flushPrelude();
    }
    this.safeEnqueue(value);
    if (this.partType(value) === "finish") {
      this.finished = true;
      const healthTransition = this.recordCandidateSuccess(idx);
      this.finishRequest(true);
      this.emitAttempt(
        idx,
        "success",
        undefined,
        undefined,
        undefined,
        healthTransition
      );
      this.releaseActiveCandidate();
    }
    if (advanced) {
      return true;
    }
    try {
      consumeGenuinePromise(this.onAdvance?.(idx, this.errors.length > 0));
    } catch {
      // Optional cooldown bookkeeping cannot alter an emitted stream.
    }
    return true;
  }

  protected cleanupReader(reader: CapturedReader): void {
    if (this.cancelled) {
      // Propagate the consumer's cancel to the live upstream (this may be a
      // survivor opened during the fallback race) so its transport closes.
      if (this.activeReader === reader) {
        this.activeReader = null;
        cancelAndReleaseReaderQuietly(reader, this.cancelReason);
      }
    } else {
      releaseReaderLockQuietly(reader);
    }
    if (this.activeReader === reader) {
      this.activeReader = null;
    }
  }

  // A read rejection after the stream already finished is just the connection
  // closing — nothing to fall back to; otherwise route it through onFailure.
  protected handleReadError(readErr: unknown, idx: number): Promise<void> {
    if (this.finished) {
      this.safeClose();
      return Promise.resolve();
    }
    return this.onFailure(readErr, idx);
  }

  // An in-band error part: ignore after finish; forward verbatim if content
  // already streamed and we won't retry; otherwise fall back (swallowing it).
  protected handleErrorPart(
    value: Extract<LanguageModelV4StreamPart, { type: "error" }>,
    idx: number
  ): Promise<void> {
    if (this.finished) {
      this.safeClose();
      return Promise.resolve();
    }
    if (this.committed && !this.config.retryAfterOutput) {
      const classification = this.classifyError(value.error);
      this.observeFailureForBudget(classification);
      const healthTransition = this.recordCandidateFailure(idx, classification);
      this.emitOnError(value.error, idx, false);
      this.emitAttempt(
        idx,
        "failure",
        value.error,
        classification,
        false,
        healthTransition
      );
      this.flushPrelude();
      this.safeEnqueue(value);
      cancelQuietly(this.activeReader, value.error);
      this.releaseActiveCandidate();
      this.finishRequest(false);
      this.safeClose();
      return Promise.resolve();
    }
    return this.onFailure(value.error, idx);
  }

  protected async pump(
    result: LanguageModelV4StreamResult,
    idx: number
  ): Promise<void> {
    this.candidateCommitted = false;
    this.candidateBudgetCheckpoint = { ...this.streamJsonBudget };
    this.validator = new StreamLifecycleValidator();
    let reader: CapturedReader | undefined;
    try {
      reader = captureReader(result);
      this.setActive(result);
    } catch (error) {
      cancelQuietly(reader ?? null, error);
      await this.onFailure(
        new InvalidModelStreamError(
          "stream result does not expose a readable stream",
          error
        ),
        idx
      );
      return;
    }
    return this.pumpReader(reader, idx);
  }

  protected async pumpReader(
    reader: CapturedReader,
    idx: number
  ): Promise<void> {
    this.activeReader = reader;
    let advanced = false; // commit this candidate to cooldown once, on first commit part
    let candidateHasOutput = false;
    const firstContentDeadline =
      this.config.firstContentTimeout === undefined
        ? undefined
        : monotonicNow() + this.config.firstContentTimeout;
    try {
      if (this.cancelled) {
        return;
      }
      for (;;) {
        await this.waitForDemand();
        let res: ReadableStreamReadResult<LanguageModelV4StreamPart>;
        try {
          res = snapshotReadResult(
            await this.readNext(reader, firstContentDeadline)
          );
        } catch (readErr) {
          await this.handleReadRejection(readErr, reader, idx);
          return;
        }
        if (this.cancelled) {
          return;
        }
        if (res.done) {
          if (this.finished) {
            this.flushPrelude();
            this.safeClose();
          } else {
            await this.onFailure(new IncompleteModelStreamError(), idx);
          }
          return;
        }
        const value = await this.snapshotAndValidatePart(res.value, idx);
        if (!this.snapshotCanContinue(value)) {
          return;
        }
        const type = this.partType(value);
        if (type === "error") {
          await this.handleErrorPart(
            value as Extract<LanguageModelV4StreamPart, { type: "error" }>,
            idx
          );
          return;
        }
        if (this.preludeWouldOverflow(value)) {
          await this.onFailure(new StreamPreludeOverflowError(), idx);
          return;
        }
        if (this.isEmptyFinish(value, candidateHasOutput)) {
          await this.onFailure(new EmptyModelStreamError(), idx);
          return;
        }
        if (this.isOutputPart(value)) {
          candidateHasOutput = true;
        }
        advanced = this.forwardPart(value, idx, advanced);
        if (type === "finish") {
          cancelQuietly(reader, "model stream finished");
          this.safeClose();
          return;
        }
      }
    } finally {
      this.cleanupReader(reader);
    }
  }

  protected snapshotCanContinue(
    value: LanguageModelV4StreamPart | undefined
  ): value is LanguageModelV4StreamPart {
    return !this.cancelled && value !== undefined;
  }

  protected waitForDemand(): Promise<void> {
    if (this.cancelled || (this.controller.desiredSize ?? 0) > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.resumeDemand = resolve;
    });
  }

  protected observeFailureForBudget(failure: FailureClassification): void {
    const hookFailure = { ...failure };
    try {
      const result = this.isBudgetFailure?.(hookFailure);
      this.budgetFailureObserved ||=
        !consumeGenuinePromise(result) && result === true;
    } catch {
      // Optional retry-budget classification cannot interrupt fallback.
    } finally {
      consumeFailureClassificationPromiseMutations(hookFailure);
    }
    this.budgetSuppressed ||= !failure.retryable && failure.scope === "request";
  }

  protected finishRequest(success: boolean): void {
    if (this.requestOutcomeObserved || this.cancelled) {
      return;
    }
    this.requestOutcomeObserved = true;
    this.cleanupAbortForwarding();
    try {
      consumeGenuinePromise(
        this.onRequestOutcome?.(
          success,
          this.budgetFailureObserved,
          this.budgetSuppressed
        )
      );
    } catch {
      // Optional retry-budget accounting cannot alter stream settlement.
    }
  }

  protected cleanupAbortForwarding(): void {
    try {
      this.removeCallerAbort?.();
    } catch {
      // Defensive: custom cleanup extensions cannot alter stream completion.
    }
    this.removeCallerAbort = undefined;
  }

  protected handleReadRejection(
    error: unknown,
    reader: CapturedReader,
    index: number
  ): Promise<void> {
    if (this.cancelled) {
      return Promise.resolve();
    }
    cancelAndReleaseReaderQuietly(reader, error);
    return this.handleReadError(error, index);
  }

  protected readNext(
    reader: CapturedReader,
    firstContentDeadline: number | undefined
  ): Promise<ReadableStreamReadResult<LanguageModelV4StreamPart>> {
    const timeoutMs =
      this.candidateCommitted || firstContentDeadline === undefined
        ? undefined
        : Math.max(0, firstContentDeadline - monotonicNow());
    if (timeoutMs === 0) {
      throw new RouterTimeoutError(
        "first_content_timeout",
        this.config.firstContentTimeout ?? 0
      );
    }
    return withTimeout(
      () => reader.read(),
      timeoutMs,
      this.operationAbort.signal,
      "first_content_timeout",
      this.config.firstContentTimeout
    );
  }
}
