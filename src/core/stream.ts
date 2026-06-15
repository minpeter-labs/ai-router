import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';

import { surfaceFailure } from './retry';
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
 * Framing / metadata stream parts that carry NO visible model output. An in-band
 * error that arrives while only these have been seen is still "pre-content", so
 * we may safely fall back. Everything not in this set counts as real output (a
 * conservative denylist: an unknown future part type is treated as content, so
 * we never risk re-emitting it). The openai-compatible provider emits
 * `response-metadata` (and often `text-start`) on its first chunk before any
 * `text-delta`, so excluding them is essential for mid-stream fallback to work.
 */
const NON_CONTENT_PARTS: ReadonlySet<string> = new Set([
  'stream-start',
  'response-metadata',
  'text-start',
  'text-end',
  'reasoning-start',
  'reasoning-end',
  'tool-input-start',
  'tool-input-end',
  'raw',
  'finish',
]);

function isContentPart(part: LanguageModelV4StreamPart): boolean {
  return !NON_CONTENT_PARTS.has(part.type);
}

/**
 * Wrap a stream result so a mid-stream failure transparently falls back to the
 * next candidate. The `request`/`response` metadata follows whichever candidate
 * is actually producing the live stream (via getters).
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
 * Fallback only happens while no real content has streamed (`hasStreamedAny`
 * false) unless `retryAfterOutput` is set — otherwise the consumer could see
 * duplicated output. A recoverable pre-output error part is SWALLOWED (never
 * enqueued) so the consumer never observes the failed candidate's terminal error.
 */
export function createFallbackStream(
  args: FallbackStreamArgs,
  setActive: (result: LanguageModelV4StreamResult) => void,
): ReadableStream<LanguageModelV4StreamPart> {
  let hasStreamedAny = false;
  let streamStartForwarded = false;
  let cancelled = false;
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

      const emitOnError = (error: unknown, idx: number, willRetry: boolean): void => {
        try {
          args.onError?.({
            logicalId: args.logicalId,
            entry: args.candidates[idx].entry,
            index: idx,
            error,
            phase: hasStreamedAny ? 'stream-mid' : 'stream-open',
            willRetry,
          });
        } catch {
          /* onError must not break the pump */
        }
      };

      const onFailure = async (error: unknown, idx: number): Promise<void> => {
        errors.push(error);
        const blockedByOutput = hasStreamedAny && !args.retryAfterOutput;

        let retry = false;
        if (!blockedByOutput) {
          try {
            retry = args.shouldRetry(error);
          } catch {
            retry = false;
          }
        }

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
        try {
          for (;;) {
            let res: ReadableStreamReadResult<LanguageModelV4StreamPart>;
            try {
              res = await reader.read();
            } catch (readErr) {
              return await onFailure(readErr, idx);
            }
            if (cancelled) return;
            if (res.done) {
              safeClose();
              return;
            }
            const value = res.value;
            if (value.type === 'error') {
              if (!hasStreamedAny || args.retryAfterOutput) {
                return await onFailure(value.error, idx);
              }
              // Post-output with retryAfterOutput=false: can't un-ring the bell —
              // forward the terminal error verbatim.
              safeEnqueue(value);
              safeClose();
              return;
            }
            // Suppress a fallback candidate's leading stream-start so the consumer
            // observes exactly one model-call lifecycle.
            if (value.type === 'stream-start') {
              if (streamStartForwarded) continue;
              streamStartForwarded = true;
            }
            safeEnqueue(value);
            if (isContentPart(value) && !hasStreamedAny) {
              hasStreamedAny = true;
              args.onAdvance?.(idx, errors.length > 0);
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            /* already released */
          }
          if (activeReader === reader) activeReader = null;
        }
      };

      await pump(args.firstResult, args.startIndex);
    },
    cancel(reason) {
      cancelled = true;
      try {
        void activeReader?.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });
}
