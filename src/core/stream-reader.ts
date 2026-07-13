import type {
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import {
  captureGenuinePromise,
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  requireGenuinePromise,
} from "./runtime-types";
import {
  MAX_PRELUDE_PARTS,
  MAX_PRELUDE_TEXT_CHARS,
  streamField,
} from "./stream-part-fields";
import { clearTimerSafely, scheduleTimer } from "./timeout";

export class IncompleteModelStreamError extends Error {
  readonly code = "incomplete_model_stream";

  constructor() {
    super("ai-router: provider stream closed without a finish part");
    this.name = "IncompleteModelStreamError";
  }
}

export class EmptyModelStreamError extends Error {
  readonly code = "empty_model_response";

  constructor() {
    super("ai-router: provider returned an empty model stream");
    this.name = "EmptyModelStreamError";
  }
}

export class StreamPreludeOverflowError extends Error {
  readonly code = "stream_prelude_overflow";

  constructor() {
    super(
      `ai-router: provider exceeded the pre-output framing limit (${MAX_PRELUDE_PARTS} parts or ${MAX_PRELUDE_TEXT_CHARS} text characters)`
    );
    this.name = "StreamPreludeOverflowError";
  }
}

export class InvalidModelStreamError extends Error {
  readonly code = "invalid_model_stream";

  constructor(message: string, cause?: unknown) {
    super(`ai-router: invalid provider stream: ${message}`, {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "InvalidModelStreamError";
  }
}

export class RouterStreamError extends Error {
  readonly code = "stream_unavailable";

  constructor(cause: unknown) {
    super("ai-router: stream infrastructure is unavailable", { cause });
    this.name = "RouterStreamError";
  }
}

export class CleanedStreamSetupError extends Error {
  constructor(cause: unknown) {
    super("stream setup failed after cleanup", { cause });
    this.name = "CleanedStreamSetupError";
  }
}

export interface CapturedReader {
  cancel(reason?: unknown): Promise<void>;
  read(): Promise<ReadableStreamReadResult<LanguageModelV4StreamPart>>;
  releaseLock(): void;
}

export function snapshotReadResult(
  value: unknown
): ReadableStreamReadResult<LanguageModelV4StreamPart> {
  if (typeof value !== "object" || value === null) {
    throw new InvalidModelStreamError("stream read result is malformed");
  }
  consumeOwnDataPromiseFields(value, ["done", "value"]);
  const done = streamField(value, "done");
  if (typeof done !== "boolean") {
    throw new InvalidModelStreamError("stream read result is malformed");
  }
  return done
    ? { done: true, value: undefined }
    : {
        done: false,
        value: streamField(value, "value") as LanguageModelV4StreamPart,
      };
}

export function tryReaderMethod(
  reader: object,
  method: "cancel" | "read" | "releaseLock"
): { error?: unknown; value?: unknown } {
  try {
    const value = Reflect.get(reader, method);
    if (consumeGenuinePromise(value)) {
      return {
        error: new Error(`stream reader ${method} must be synchronous`),
      };
    }
    return { value };
  } catch (error) {
    return { error };
  }
}

export function cleanupPartialReader(
  reader: object,
  cancel: unknown,
  releaseLock: unknown
): void {
  try {
    if (typeof cancel === "function") {
      consumeGenuinePromise(
        Reflect.apply(cancel, reader, ["stream reader capture failed"])
      );
    }
  } catch {
    // Partial reader cleanup is best-effort.
  }
  try {
    if (typeof releaseLock === "function") {
      consumeGenuinePromise(Reflect.apply(releaseLock, reader, []));
    }
  } catch {
    // Partial reader cleanup is best-effort.
  }
}

export function cleanupUnreadableStream(stream: object, reason: unknown): void {
  try {
    const cancel = Reflect.get(stream, "cancel");
    if (consumeGenuinePromise(cancel) || typeof cancel !== "function") {
      return;
    }
    consumeGenuinePromise(Reflect.apply(cancel, stream, [reason]));
  } catch {
    // A stream that cannot expose a reader is detached from routing; cleanup is
    // best-effort and must not replace the reader-capture failure.
  }
}

export function captureReader(
  result: LanguageModelV4StreamResult
): CapturedReader {
  const stream = Reflect.get(result as object, "stream");
  if (consumeGenuinePromise(stream)) {
    throw new Error("stream must be synchronous");
  }
  if (typeof stream !== "object" || stream === null) {
    throw new Error("stream is unavailable");
  }
  let reader: unknown;
  try {
    const getReader = Reflect.get(stream, "getReader");
    if (consumeGenuinePromise(getReader)) {
      throw new Error("stream.getReader must be synchronous");
    }
    if (typeof getReader !== "function") {
      throw new Error("stream.getReader is unavailable");
    }
    reader = Reflect.apply(getReader, stream, []);
    if (consumeGenuinePromise(reader)) {
      throw new Error("stream reader must be synchronous");
    }
    if (typeof reader !== "object" || reader === null) {
      throw new Error("stream reader is unavailable");
    }
  } catch (error) {
    cleanupUnreadableStream(stream, error);
    throw error;
  }
  const cancelResult = tryReaderMethod(reader, "cancel");
  const releaseResult = tryReaderMethod(reader, "releaseLock");
  const readResult = tryReaderMethod(reader, "read");
  const cancel = cancelResult.value;
  const read = readResult.value;
  const releaseLock = releaseResult.value;
  const methodError =
    cancelResult.error ?? releaseResult.error ?? readResult.error;
  if (
    methodError !== undefined ||
    typeof cancel !== "function" ||
    typeof read !== "function" ||
    typeof releaseLock !== "function"
  ) {
    cleanupPartialReader(reader, cancel, releaseLock);
    if (methodError !== undefined) {
      throw methodError;
    }
    throw new Error("stream reader methods are unavailable");
  }
  return {
    cancel(reason) {
      return Reflect.apply(cancel, reader, [reason]) as Promise<void>;
    },
    read() {
      return requireGenuinePromise(
        Reflect.apply(read, reader, []),
        (error) =>
          new InvalidModelStreamError(
            "reader.read must return a genuine Promise",
            error
          )
      );
    },
    releaseLock() {
      consumeGenuinePromise(Reflect.apply(releaseLock, reader, []));
    },
  };
}

/** Cancel an upstream reader, swallowing a sync throw or async rejection. */
export const cancelledReaders = new WeakSet<CapturedReader>();

export function cancelQuietly(
  reader: CapturedReader | null,
  reason: unknown
): void {
  cancelAndReleaseReaderQuietly(reader, reason);
}

export const releasedReaderLocks = new WeakSet<CapturedReader>();

export function releaseReaderLockQuietly(reader: CapturedReader): void {
  if (releasedReaderLocks.has(reader)) {
    return;
  }
  try {
    reader.releaseLock();
    releasedReaderLocks.add(reader);
  } catch {
    // A pending read or already-released reader has no additional safe action.
  }
}

export function cancelAndReleaseReaderQuietly(
  reader: CapturedReader | null,
  reason: unknown
): void {
  if (reader === null) {
    return;
  }
  if (cancelledReaders.has(reader)) {
    return;
  }
  cancelledReaders.add(reader);
  let cancellation: unknown;
  try {
    cancellation = reader.cancel(reason);
  } catch {
    // Lock release below remains independently best-effort.
  }
  const promise = captureGenuinePromise(cancellation);
  if (promise === undefined) {
    releaseReaderLockQuietly(reader);
    return;
  }
  let pendingReader: CapturedReader | undefined = reader;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (pendingReader !== undefined) {
      releaseReaderLockQuietly(pendingReader);
      pendingReader = undefined;
    }
    clearTimerSafely(timer);
  };
  try {
    timer = scheduleTimer(finish, 1000);
  } catch {
    finish();
  }
  promise.then(finish, finish);
}
