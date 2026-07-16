import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";

interface AbortSignalOperations {
  add: AbortSignal["addEventListener"];
  remove: AbortSignal["removeEventListener"];
}

const operationsBySignal = new WeakMap<object, AbortSignalOperations>();

export function captureAbortSignalOperations(
  value: unknown
): AbortSignalOperations | undefined {
  if (value === undefined) {
    return;
  }
  if (consumeGenuinePromise(value)) {
    throw new Error("abortSignal must be synchronous");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("abortSignal must implement AbortSignal");
  }
  const existing = operationsBySignal.get(value);
  if (existing !== undefined) {
    return existing;
  }
  consumeOwnDataPromiseFields(value, [
    "addEventListener",
    "removeEventListener",
  ]);
  const add = Reflect.get(value, "addEventListener");
  const remove = Reflect.get(value, "removeEventListener");
  const asyncAdd = consumeGenuinePromise(add);
  const asyncRemove = consumeGenuinePromise(remove);
  if (
    asyncAdd ||
    asyncRemove ||
    typeof add !== "function" ||
    typeof remove !== "function"
  ) {
    throw new Error("abortSignal must implement AbortSignal");
  }
  const operations = { add, remove } as AbortSignalOperations;
  operationsBySignal.set(value, operations);
  return operations;
}

export function addCapturedAbortListener(
  signal: AbortSignal,
  listener: () => void
): () => void {
  const operations = captureAbortSignalOperations(signal);
  if (operations === undefined) {
    return () => undefined;
  }
  let active = true;
  let delivered = false;
  const guardedListener = () => {
    if (!active || delivered) {
      return;
    }
    delivered = true;
    listener();
  };
  const cleanup = () => {
    if (!active) {
      return;
    }
    active = false;
    try {
      consumeGenuinePromise(
        operations.remove.call(signal, "abort", guardedListener)
      );
    } catch {
      // Cleanup is best-effort and must not replace the operation outcome.
    }
  };
  try {
    const registration = operations.add.call(signal, "abort", guardedListener, {
      once: true,
    });
    if (consumeGenuinePromise(registration)) {
      throw new Error("abort listener registration must be synchronous");
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}
