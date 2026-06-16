import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";

import { safeShouldRetry, surfaceFailure } from "./retry";
import type { OnRouterError, ProviderEntry } from "./types";

/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */
export interface ResolvedEntry {
  /** The user's original `ProviderEntry` (surfaced verbatim on `onError`). */
  entry: ProviderEntry;
  /** Index into the full (unfiltered) entries array. */
  fullIndex: number;
  /** The instantiated v4 model. */
  model: LanguageModelV4;
}

export interface FallbackStreamArgs {
  /** Modality-filtered candidates, in order. */
  candidates: ResolvedEntry[];
  /** The already-awaited stream result of `candidates[startIndex]`. */
  firstResult: LanguageModelV4StreamResult;
  logicalId: string;
  /** Cooldown hook: commit the candidate at this filtered index as the survivor. */
  onAdvance?: (filteredIndex: number, hadFailure: boolean) => void;
  onError?: OnRouterError;
  options: LanguageModelV4CallOptions;
  /** Pre-open failures (candidates that threw before `firstResult`) for the aggregate. */
  priorErrors?: unknown[];
  /** Retry even after content has streamed (may duplicate output). */
  retryAfterOutput: boolean;
  /** Retry classifier (already resolved). `true` => fall through to the next candidate. */
  shouldRetry: (error: unknown) => boolean;
  /** Index into `candidates` of the first attempt (the one `firstResult` came from). */
  startIndex: number;
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
  "stream-start",
  "response-metadata",
  "text-start",
  "text-end",
  "reasoning-start",
  "reasoning-end",
  "tool-input-start",
  "tool-input-end",
  "raw",
]);

function isFramingPart(part: LanguageModelV4StreamPart): boolean {
  return FRAMING_PARTS.has(part.type);
}

/** Cancel an upstream reader, swallowing a sync throw or async rejection. */
function cancelQuietly(
  reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | null,
  reason: unknown
): void {
  if (reader === null) {
    return;
  }
  try {
    Promise.resolve(reader.cancel(reason)).catch(() => {
      // A transport may reject while aborting; nothing to recover.
    });
  } catch {
    // A synchronous throw from cancel(); ignore.
  }
}

/**
 * Wrap a stream result so a mid-stream failure transparently falls back to the
 * next candidate. The `request`/`response` metadata getters track whichever
 * candidate is producing the live stream — best-effort, since a consumer that
 * snapshots them at stream-open (as the AI SDK does) keeps the first candidate's
 * values across a later fallback.
 */
export function wrapStreamResult(
  args: FallbackStreamArgs
): LanguageModelV4StreamResult {
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
  setActive: (result: LanguageModelV4StreamResult) => void
): ReadableStream<LanguageModelV4StreamPart> {
  let pump: FallbackPump | null = null;
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      pump = new FallbackPump(args, setActive, controller);
      return pump.run();
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
class FallbackPump {
  private committed = false; // has the live candidate emitted content / finished?
  private finished = false; // a `finish` part was emitted; the stream is complete
  private prelude: LanguageModelV4StreamPart[] = []; // buffered framing of the live candidate
  private cancelled = false;
  private cancelReason: unknown;
  private readonly errors: unknown[];
  private activeReader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | null =
    null;

  private readonly args: FallbackStreamArgs;
  private readonly setActive: (result: LanguageModelV4StreamResult) => void;
  private readonly controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>;

  constructor(
    args: FallbackStreamArgs,
    setActive: (result: LanguageModelV4StreamResult) => void,
    controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>
  ) {
    this.args = args;
    this.setActive = setActive;
    this.controller = controller;
    this.errors = args.priorErrors ? [...args.priorErrors] : [];
  }

  run(): Promise<void> {
    return this.pump(this.args.firstResult, this.args.startIndex);
  }

  cancel(reason: unknown): void {
    this.cancelled = true;
    this.cancelReason = reason;
    cancelQuietly(this.activeReader, reason);
  }

  private safeEnqueue(part: LanguageModelV4StreamPart): void {
    try {
      this.controller.enqueue(part);
    } catch {
      // Controller already closed/errored (e.g. after cancel).
    }
  }

  private safeClose(): void {
    try {
      this.controller.close();
    } catch {
      // Already closed.
    }
  }

  private safeError(error: unknown): void {
    try {
      this.controller.error(error);
    } catch {
      // Already closed/errored.
    }
  }

  private flushPrelude(): void {
    for (const part of this.prelude) {
      this.safeEnqueue(part);
    }
    this.prelude = [];
  }

  private emitOnError(error: unknown, idx: number, willRetry: boolean): void {
    try {
      this.args.onError?.({
        logicalId: this.args.logicalId,
        entry: this.args.candidates[idx].entry,
        index: idx,
        error,
        phase: this.committed ? "stream-mid" : "stream-open",
        willRetry,
      });
    } catch {
      // onError must not break the pump.
    }
  }

  private async onFailure(error: unknown, idx: number): Promise<void> {
    // The failed candidate's buffered framing is dropped — it never streams.
    this.prelude = [];
    this.errors.push(error);
    const blockedByOutput = this.committed && !this.args.retryAfterOutput;
    const retry = blockedByOutput
      ? false
      : safeShouldRetry(this.args.shouldRetry, error);

    const nextIdx = idx + 1;
    const hasNext = retry && nextIdx < this.args.candidates.length;
    this.emitOnError(error, idx, hasNext);

    if (blockedByOutput) {
      this.safeError(error);
      return;
    }
    if (!retry) {
      this.safeError(surfaceFailure(this.errors, this.args.logicalId));
      return;
    }
    if (!hasNext) {
      this.safeError(surfaceFailure(this.errors, this.args.logicalId));
      return;
    }
    if (this.cancelled) {
      return;
    }

    let nextResult: LanguageModelV4StreamResult;
    try {
      nextResult = await this.args.candidates[nextIdx].model.doStream(
        this.args.options
      );
    } catch (openErr) {
      return this.onFailure(openErr, nextIdx);
    }
    return this.pump(nextResult, nextIdx);
  }

  // Buffer framing pre-commit, else commit + forward. Returns whether this
  // candidate has been committed to cooldown yet.
  private forwardPart(
    value: LanguageModelV4StreamPart,
    idx: number,
    advanced: boolean
  ): boolean {
    if (isFramingPart(value)) {
      if (this.committed) {
        this.safeEnqueue(value); // post-commit framing passes through
      } else {
        this.prelude.push(value); // pre-commit framing is buffered
      }
      return advanced;
    }
    // A commit part: real content, or a `finish` terminal.
    if (!this.committed) {
      this.committed = true;
      this.flushPrelude();
    }
    this.safeEnqueue(value);
    if (value.type === "finish") {
      this.finished = true;
    }
    if (advanced) {
      return true;
    }
    this.args.onAdvance?.(idx, this.errors.length > 0);
    return true;
  }

  private cleanupReader(
    reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>
  ): void {
    if (this.cancelled) {
      // Propagate the consumer's cancel to the live upstream (this may be a
      // survivor opened during the fallback race) so its transport closes.
      cancelQuietly(reader, this.cancelReason);
    } else {
      try {
        reader.releaseLock();
      } catch {
        // Already released.
      }
    }
    if (this.activeReader === reader) {
      this.activeReader = null;
    }
  }

  // A read rejection after the stream already finished is just the connection
  // closing — nothing to fall back to; otherwise route it through onFailure.
  private handleReadError(readErr: unknown, idx: number): Promise<void> {
    if (this.finished) {
      this.safeClose();
      return Promise.resolve();
    }
    return this.onFailure(readErr, idx);
  }

  // An in-band error part: ignore after finish; forward verbatim if content
  // already streamed and we won't retry; otherwise fall back (swallowing it).
  private handleErrorPart(
    value: Extract<LanguageModelV4StreamPart, { type: "error" }>,
    idx: number
  ): Promise<void> {
    if (this.finished) {
      this.safeClose();
      return Promise.resolve();
    }
    if (this.committed && !this.args.retryAfterOutput) {
      this.flushPrelude();
      this.safeEnqueue(value);
      this.safeClose();
      return Promise.resolve();
    }
    return this.onFailure(value.error, idx);
  }

  private async pump(
    result: LanguageModelV4StreamResult,
    idx: number
  ): Promise<void> {
    this.setActive(result);
    const reader = result.stream.getReader();
    this.activeReader = reader;
    let advanced = false; // commit this candidate to cooldown once, on first commit part
    try {
      if (this.cancelled) {
        return;
      }
      for (;;) {
        let res: ReadableStreamReadResult<LanguageModelV4StreamPart>;
        try {
          res = await reader.read();
        } catch (readErr) {
          await this.handleReadError(readErr, idx);
          return;
        }
        if (this.cancelled) {
          return;
        }
        if (res.done) {
          this.flushPrelude();
          this.safeClose();
          return;
        }
        const value = res.value;
        if (value.type === "error") {
          await this.handleErrorPart(value, idx);
          return;
        }
        advanced = this.forwardPart(value, idx, advanced);
      }
    } finally {
      this.cleanupReader(reader);
    }
  }
}
