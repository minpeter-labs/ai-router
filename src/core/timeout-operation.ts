import { addCapturedAbortListener } from "./abort-signal";
import { consumeGenuinePromise } from "./runtime-types";
import {
  abortControllerSafely,
  clearTimerSafely,
  createAbortControllerSafely,
  isSignalAborted,
  RouterTimeoutError,
  scheduleTimer,
  signalAbortReason,
} from "./timeout";

export async function withTimeout<T>(
  operation: (signal: AbortSignal | undefined) => PromiseLike<T>,
  timeoutMs: number | undefined,
  callerSignal: AbortSignal | undefined,
  code: RouterTimeoutError["code"] = "attempt_timeout",
  diagnosticDurationMs: number | undefined = timeoutMs,
  onLateResolve?: (value: T) => unknown
): Promise<T> {
  if (isSignalAborted(callerSignal)) {
    throw signalAbortReason(callerSignal);
  }
  const invoke = (signal: AbortSignal | undefined): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      try {
        resolve(operation(signal));
      } catch (error) {
        reject(error);
      }
    });
  if (timeoutMs === undefined && callerSignal === undefined) {
    return await invoke(undefined);
  }
  const controller = createAbortControllerSafely();
  const signal = controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeCallerAbort: (() => void) | undefined;
  let callerAbortReason: unknown;
  let callerAbortObserved = false;
  let rejectTimeout: ((error: unknown) => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  if (timeoutMs !== undefined) {
    timer = scheduleTimer(() => {
      const error = new RouterTimeoutError(
        code,
        diagnosticDurationMs ?? timeoutMs
      );
      abortControllerSafely(controller, error);
      rejectTimeout?.(error);
    }, timeoutMs);
  }
  const callerAbort =
    callerSignal === undefined
      ? new Promise<never>(() => undefined)
      : new Promise<never>((_, reject) => {
          const onAbort = () => {
            if (callerAbortObserved) {
              return;
            }
            callerAbortObserved = true;
            callerAbortReason = signalAbortReason(callerSignal);
            abortControllerSafely(controller, callerAbortReason);
            reject(callerAbortReason);
          };
          try {
            removeCallerAbort = addCapturedAbortListener(callerSignal, onAbort);
            if (isSignalAborted(callerSignal)) {
              onAbort();
            }
          } catch (error) {
            abortControllerSafely(controller, error);
            reject(error);
          }
        });
  let raceSettled = false;
  const operationPromise = Promise.resolve()
    .then(() => {
      if (isSignalAborted(signal)) {
        throw signalAbortReason(signal);
      }
      return invoke(signal);
    })
    .then((value) => {
      if (raceSettled) {
        try {
          consumeGenuinePromise(onLateResolve?.(value));
        } catch {
          // Cleanup is best-effort and must never become an unhandled rejection.
        }
      }
      return value;
    });
  try {
    return await Promise.race([operationPromise, timeout, callerAbort]);
  } catch (error) {
    if (callerAbortObserved) {
      throw callerAbortReason;
    }
    if (isSignalAborted(callerSignal)) {
      callerAbortObserved = true;
      callerAbortReason = signalAbortReason(callerSignal);
      throw callerAbortReason;
    }
    throw error;
  } finally {
    raceSettled = true;
    clearTimerSafely(timer);
    removeCallerAbort?.();
  }
}
