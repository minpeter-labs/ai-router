import type {
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { isTerminalRequestFailure } from "./failure";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";
import { runSetupCandidateCleanup } from "./stream-candidate-cleanup";
import { tryCaptureOptionalHook } from "./stream-candidate-hooks";
import { FallbackPump } from "./stream-pump";
import { CleanedStreamSetupError, RouterStreamError } from "./stream-reader";
import {
  copyStreamRequest,
  copyStreamResponse,
  type StreamMetadataSnapshot,
  snapshotStreamResultMetadata,
} from "./stream-result";
import type { FallbackStreamArgs } from "./stream-types";

export type { FallbackStreamArgs, ResolvedEntry } from "./stream-types";

export const FALLBACK_STREAM_ARG_KEYS = [
  "acquireCandidate",
  "attemptsStarted",
  "attemptTimeout",
  "backoff",
  "budgetFailureObserved",
  "budgetSuppressed",
  "candidateAvailable",
  "candidateInFlight",
  "candidates",
  "classifyFailure",
  "concurrencyLimit",
  "firstContentTimeout",
  "firstResult",
  "isBudgetFailure",
  "logicalId",
  "maxAttempts",
  "nextOrderingToken",
  "onAdvance",
  "onAttempt",
  "onCandidateFailure",
  "onCandidateSuccess",
  "onError",
  "onRequestOutcome",
  "options",
  "prepareCandidate",
  "priorErrors",
  "releaseCandidate",
  "releaseProbeCandidate",
  "retryAfterOutput",
  "shouldRetry",
  "startAttemptStartedAt",
  "startIndex",
  "startInFlight",
  "startOrderingToken",
  "strictStreamValidation",
  "totalDeadline",
  "totalTimeout",
  "waitForCandidate",
] as const;

export function captureFallbackStreamArgPromises(
  value: unknown
): asserts value is FallbackStreamArgs {
  if (consumeGenuinePromise(value)) {
    throw new TypeError("ai-router: stream arguments must be synchronous");
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError("ai-router: stream arguments must be an object");
  }
  consumeOwnDataPromiseFields(value, FALLBACK_STREAM_ARG_KEYS);
}

export function fallbackStreamArgField(
  source: FallbackStreamArgs,
  key: (typeof FALLBACK_STREAM_ARG_KEYS)[number]
): unknown {
  const value = Reflect.get(source, key);
  if (consumeGenuinePromise(value)) {
    throw new TypeError(`ai-router: stream ${key} must be synchronous`);
  }
  return value;
}

export function cancelLateStreamResult(
  result: LanguageModelV4StreamResult
): void {
  try {
    const stream = Reflect.get(result as object, "stream");
    if (consumeGenuinePromise(stream)) {
      return;
    }
    if (typeof stream !== "object" || stream === null) {
      return;
    }
    const cancel = Reflect.get(stream, "cancel");
    if (consumeGenuinePromise(cancel)) {
      return;
    }
    if (typeof cancel !== "function") {
      return;
    }
    consumeGenuinePromise(
      Reflect.apply(cancel, stream, ["late stream result discarded"])
    );
  } catch {
    // Hostile/malformed late results are already detached from routing.
  }
}

/** Cancel a stream result that arrived after its opening attempt was abandoned. */
export function discardLateStreamResult(
  result: LanguageModelV4StreamResult
): void {
  consumeOwnDataPromiseFields(result as object, [
    "request",
    "response",
    "stream",
  ]);
  cancelLateStreamResult(result);
  // A late result bypasses the normal wrapper snapshot. Start transport
  // cancellation first, then reuse the bounded metadata traversal so a large
  // discarded body cannot delay cleanup of the live upstream.
  snapshotStreamResultMetadata(result);
}

/**
 * Framing / metadata stream parts that carry NO visible model output. Before a
 * candidate "commits" (emits real content or a `finish`), these are BUFFERED:
 * if the candidate then fails pre-commit they are discarded (so the failed
 * candidate contributes nothing to the consumer), and if it commits they are
 * flushed ahead of the content. This is what lets a fallback be transparent —
 * the openai-compatible provider emits `response-metadata` (and often
 * `text-start`) on its first chunk before any `text-delta`, so a pre-content
 * error after them must still discard them and fall back cleanly, not leak a
 * half-open text block. `finish` is NOT framing — it is a commit + terminal.
 *
 * A conservative denylist: an unknown future part type is treated as content
 * (committing), so we never risk re-emitting it across a fallback.
 */
export function wrapStreamResult(
  args: FallbackStreamArgs
): LanguageModelV4StreamResult {
  let firstResult: LanguageModelV4StreamResult | undefined;
  let active: StreamMetadataSnapshot = {
    request: undefined,
    response: undefined,
  };
  let initialActivation = true;
  let stream: ReadableStream<LanguageModelV4StreamPart>;
  try {
    captureFallbackStreamArgPromises(args);
    firstResult = fallbackStreamArgField(
      args,
      "firstResult"
    ) as LanguageModelV4StreamResult;
    active = snapshotStreamResultMetadata(firstResult);
    stream = createFallbackStream(
      args,
      (result) => {
        if (initialActivation && result === firstResult) {
          initialActivation = false;
          return;
        }
        initialActivation = false;
        active = snapshotStreamResultMetadata(result);
      },
      firstResult
    );
  } catch (error) {
    const cause =
      error instanceof CleanedStreamSetupError ? error.cause : error;
    if (!(error instanceof CleanedStreamSetupError)) {
      if (firstResult !== undefined) {
        discardLateStreamResult(firstResult);
      }
      const releaseCandidate = tryCaptureOptionalHook<
        FallbackStreamArgs["releaseCandidate"]
      >(args, "releaseCandidate").value;
      const releaseProbeCandidate = tryCaptureOptionalHook<
        FallbackStreamArgs["releaseProbeCandidate"]
      >(args, "releaseProbeCandidate").value;
      try {
        runSetupCandidateCleanup(args, releaseCandidate, releaseProbeCandidate);
      } catch {
        // Preserve the infrastructure failure across hostile candidate access.
      }
    }
    throw isTerminalRequestFailure(cause)
      ? cause
      : new RouterStreamError(cause);
  }
  return {
    stream,
    get request() {
      return copyStreamRequest(active.request);
    },
    get response() {
      return copyStreamResponse(active.response);
    },
  };
}

/**
 * Build the wrapped `ReadableStream`. We own the reader lifecycle (rather than
 * using a `TransformStream`) so the underlying source can be swapped mid-flight.
 *
 * Failure is detected two ways, both routed through `onFailure`:
 *  1. An in-band `{ type: 'error' }` part (the openai-compatible provider does
 *     NOT reject the stream — it enqueues this and closes normally).
 *  2. A rejected `reader.read()` (transport abort / connection drop).
 *
 * Each candidate's leading framing parts are BUFFERED until it "commits" (emits
 * real content or a `finish`). A candidate that fails before committing has its
 * buffered framing DISCARDED and contributes nothing to the consumer — so a
 * fallback emits exactly one clean lifecycle (one stream-start, one text block),
 * never duplicate/half-open parts. Fallback only happens pre-commit unless
 * `retryAfterOutput` is set.
 */
export function createFallbackStream(
  args: FallbackStreamArgs,
  setActive: (result: LanguageModelV4StreamResult) => void,
  firstResult?: LanguageModelV4StreamResult
): ReadableStream<LanguageModelV4StreamPart> {
  captureFallbackStreamArgPromises(args);
  const capturedFirstResult =
    firstResult === undefined
      ? (fallbackStreamArgField(
          args,
          "firstResult"
        ) as LanguageModelV4StreamResult)
      : firstResult;
  let pump: FallbackPump | null = null;
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      pump = new FallbackPump(args, setActive, controller, capturedFirstResult);
      pump.run().catch((error: unknown) => pump?.failUnexpected(error));
    },
    pull() {
      pump?.resume();
    },
    cancel(reason) {
      pump?.cancel(reason);
    },
  });
}

/**
 * Drives one wrapped stream: pumps the active candidate, buffers its framing
 * until it commits, and falls back to the next candidate on a pre-commit
 * failure. Extracted to a class so each step is a small method (rather than one
 * deeply-nested closure).
 */
