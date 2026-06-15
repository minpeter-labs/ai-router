import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';

import { safeShouldRetry, surfaceFailure } from './retry';
import type { OnRouterError, ProviderEntry } from './types';

/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */
export interface ResolvedEntry {
  /** The user's original `ProviderEntry` (surfaced verbatim on `onError`). */
  entry: ProviderEntry;
  /** The instantiated v4 model. */
  model: LanguageModelV4;
  /** Index into the full (unfiltered) entries array. */
  fullIndex: number;
}

export interface FallbackStreamArgs {
  logicalId: string;
  /** Modality-filtered candidates, in order. */
  candidates: ResolvedEntry[];
  /** Index into `candidates` of the first attempt (the one `firstResult` came from). */
  startIndex: number;
  options: LanguageModelV4CallOptions;
  /** The already-awaited stream result of `candidates[startIndex]`. */
  firstResult: LanguageModelV4StreamResult;
  /** Retry classifier (already resolved). `true` => fall through to the next candidate. */
  shouldRetry: (error: unknown) => boolean;
  /** Retry even after content has streamed (may duplicate output). */
  retryAfterOutput: boolean;
  onError?: OnRouterError;
  /** Cooldown hook: commit the candidate at this filtered index as the survivor. */
  onAdvance?: (filteredIndex: number, hadFailure: boolean) => void;
  /** Pre-open failures (candidates that threw before `firstResult`) for the aggregate. */
  priorErrors?: unknown[];
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
const FRAMING_PARTS: ReadonlySet<string> = new Set([
  'stream-start',
  'response-metadata',
  'text-start',
  'text-end',
  'reasoning-start',
  'reasoning-end',
  'tool-input-start',
  'tool-input-end',
  'raw',
]);

function isFramingPart(part: LanguageModelV4StreamPart): boolean {
  return FRAMING_PARTS.has(part.type);
}

/**
 * Wrap a stream result so a mid-stream failure transparently falls back to the
 * next candidate. The `request`/`response` metadata getters track whichever
 * candidate is producing the live stream — best-effort, since a consumer that
 * snapshots them at stream-open (as the AI SDK does) keeps the first candidate's
 * values across a later fallback.
 */
export function wrapStreamResult(args: FallbackStreamArgs): LanguageModelV4StreamResult {
  let active: LanguageModelV4StreamResult = args.firstResult;
  const stream = createFallbackStream(args, (result) => {
    active = result;
  });
  return {
    stream,
    get request() {
      return active.request;
    },
    get response() {
      return active.response;
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
): ReadableStream<LanguageModelV4StreamPart> {
  let committed = false; // has the live candidate emitted content / finished?
  let finished = false; // a `finish` part was emitted; the stream is complete
  let prelude: LanguageModelV4StreamPart[] = []; // current candidate's buffered framing
  let cancelled = false;
  let cancelReason: unknown;
  const errors: unknown[] = args.priorErrors ? [...args.priorErrors] : [];
  let activeReader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | null = null;

  return new ReadableStream<LanguageModelV4StreamPart>({
    async start(controller) {
      const safeEnqueue = (part: LanguageModelV4StreamPart): void => {
        try {
          controller.enqueue(part);
        } catch {
          /* controller already closed/errored (e.g. after cancel) */
        }
      };
      const safeClose = (): void => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const safeError = (error: unknown): void => {
        try {
          controller.error(error);
        } catch {
          /* already closed/errored */
        }
      };
      const flushPrelude = (): void => {
        for (const part of prelude) safeEnqueue(part);
        prelude = [];
      };

      const emitOnError = (error: unknown, idx: number, willRetry: boolean): void => {
        try {
          args.onError?.({
            logicalId: args.logicalId,
            entry: args.candidates[idx].entry,
            index: idx,
            error,
            phase: committed ? 'stream-mid' : 'stream-open',
            willRetry,
          });
        } catch {
          /* onError must not break the pump */
        }
      };

      const onFailure = async (error: unknown, idx: number): Promise<void> => {
        // The failed candidate's buffered framing is dropped — it never streams.
        prelude = [];
        errors.push(error);
        const blockedByOutput = committed && !args.retryAfterOutput;
        const retry = blockedByOutput ? false : safeShouldRetry(args.shouldRetry, error);

        const nextIdx = idx + 1;
        const hasNext = retry && nextIdx < args.candidates.length;
        emitOnError(error, idx, hasNext);

        if (blockedByOutput || !retry) {
          safeError(error);
          return;
        }
        if (!hasNext) {
          safeError(surfaceFailure(errors, args.logicalId));
          return;
        }
        if (cancelled) return;

        let nextResult: LanguageModelV4StreamResult;
        try {
          nextResult = await args.candidates[nextIdx].model.doStream(args.options);
        } catch (openErr) {
          return onFailure(openErr, nextIdx);
        }
        return pump(nextResult, nextIdx);
      };

      const pump = async (result: LanguageModelV4StreamResult, idx: number): Promise<void> => {
        setActive(result);
        const reader = result.stream.getReader();
        activeReader = reader;
        let advanced = false; // commit this candidate to cooldown once, on first commit part
        try {
          if (cancelled) return;
          for (;;) {
            let res: ReadableStreamReadResult<LanguageModelV4StreamPart>;
            try {
              res = await reader.read();
            } catch (readErr) {
              // A read rejection after the stream already finished is just the
              // connection closing — nothing left to fall back to.
              if (finished) {
                safeClose();
                return;
              }
              return await onFailure(readErr, idx);
            }
            if (cancelled) return;
            if (res.done) {
              flushPrelude();
              safeClose();
              return;
            }
            const value = res.value;

            if (value.type === 'error') {
              if (finished) {
                safeClose();
                return;
              }
              if (committed && !args.retryAfterOutput) {
                // Content already streamed and we won't retry — forward verbatim.
                flushPrelude();
                safeEnqueue(value);
                safeClose();
                return;
              }
              return await onFailure(value.error, idx);
            }

            if (isFramingPart(value)) {
              if (committed) safeEnqueue(value); // post-commit framing passes through
              else prelude.push(value); // pre-commit framing is buffered
              continue;
            }

            // A commit part: real content, or a `finish` terminal.
            if (!committed) {
              committed = true;
              flushPrelude();
            }
            safeEnqueue(value);
            if (value.type === 'finish') finished = true;
            if (!advanced) {
              advanced = true;
              args.onAdvance?.(idx, errors.length > 0);
            }
          }
        } finally {
          if (cancelled) {
            // Propagate the consumer's cancel to the live upstream (this may be a
            // survivor opened during the fallback race) so its transport closes.
            try {
              void Promise.resolve(reader.cancel(cancelReason)).catch(() => {});
            } catch {
              /* ignore */
            }
          } else {
            try {
              reader.releaseLock();
            } catch {
              /* already released */
            }
          }
          if (activeReader === reader) activeReader = null;
        }
      };

      await pump(args.firstResult, args.startIndex);
    },
    cancel(reason) {
      cancelled = true;
      cancelReason = reason;
      try {
        void Promise.resolve(activeReader?.cancel(reason)).catch(() => {});
      } catch {
        /* ignore */
      }
    },
  });
}
