import { addCapturedAbortListener } from "./abort-signal";
import { parseDuration } from "./cooldown";
import { consumeGenuinePromise } from "./runtime-types";

const MAX_TIMEOUT_MS = 86_400_000;
const MAX_MONOTONIC_MS = Number.MAX_SAFE_INTEGER - MAX_TIMEOUT_MS;

import type { Duration } from "./types";

export function isSignalAborted(signal: AbortSignal | undefined): boolean {
  try {
    const aborted = signal?.aborted;
    return !consumeGenuinePromise(aborted) && aborted === true;
  } catch {
    return false;
  }
}

export function signalAbortReason(signal: AbortSignal | undefined): unknown {
  try {
    const reason = signal?.reason;
    return consumeGenuinePromise(reason)
      ? new DOMException("aborted", "AbortError")
      : (reason ?? new DOMException("aborted", "AbortError"));
  } catch {
    return new DOMException("aborted", "AbortError");
  }
}

/** Monotonic clock for elapsed-time budgets; wall-clock jumps must not alter them. */
export function monotonicNow(): number {
  try {
    const value = globalThis.performance?.now();
    if (consumeGenuinePromise(value)) {
      throw new Error("async performance clock is unsupported");
    }
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= MAX_MONOTONIC_MS
    ) {
      return value;
    }
  } catch {
    // Older/embedded runtimes may not expose a usable Performance clock.
  }
  try {
    const value = Date.now();
    if (consumeGenuinePromise(value)) {
      throw new Error("async wall clock is unsupported");
    }
    if (Number.isFinite(value) && value >= 0 && value <= MAX_MONOTONIC_MS) {
      return value;
    }
  } catch {
    // A hostile clock must not make timeout bookkeeping throw.
  }
  return 0;
}

export function clearTimerSafely(
  timer: ReturnType<typeof setTimeout> | undefined
): void {
  if (timer === undefined) {
    return;
  }
  try {
    consumeGenuinePromise(clearTimeout(timer));
  } catch {
    // Platform cleanup must not replace an operation's settled outcome.
  }
}

export class RouterTimerError extends Error {
  readonly code = "timer_unavailable";

  constructor(cause: unknown) {
    super("ai-router: platform timer is unavailable", { cause });
    this.name = "RouterTimerError";
  }
}

export class RouterCancellationError extends Error {
  readonly code = "cancellation_unavailable";

  constructor(cause: unknown) {
    super("ai-router: cancellation infrastructure is unavailable", { cause });
    this.name = "RouterCancellationError";
  }
}

export function createAbortControllerSafely(): AbortController {
  try {
    return new AbortController();
  } catch (error) {
    throw new RouterCancellationError(error);
  }
}

export function abortControllerSafely(
  controller: AbortController,
  reason: unknown
): void {
  try {
    const abort = Reflect.get(controller, "abort");
    if (consumeGenuinePromise(abort) || typeof abort !== "function") {
      return;
    }
    consumeGenuinePromise(Reflect.apply(abort, controller, [reason]));
  } catch {
    // A broken cancellation primitive must not prevent promise settlement.
  }
}

export function scheduleTimer(
  callback: () => void,
  delay: number
): ReturnType<typeof setTimeout> {
  try {
    const timer = setTimeout(callback, delay);
    if (consumeGenuinePromise(timer)) {
      throw new Error("timer registration returned a Promise");
    }
    return timer;
  } catch (error) {
    throw new RouterTimerError(error);
  }
}

function randomUnit(): number {
  try {
    const value = Math.random();
    if (consumeGenuinePromise(value)) {
      return 0;
    }
    return Number.isFinite(value) && value >= 0 && value < 1 ? value : 0;
  } catch {
    return 0;
  }
}

export class RouterTimeoutError extends Error {
  readonly code: "attempt_timeout" | "first_content_timeout" | "total_timeout";
  readonly durationMs: number;

  constructor(code: RouterTimeoutError["code"], durationMs: number) {
    super(`ai-router: ${code.replaceAll("_", " ")} after ${durationMs}ms`);
    this.code = code;
    this.durationMs = durationMs;
    this.name = "RouterTimeoutError";
  }
}

export function durationMs(
  value: Duration | number | undefined
): number | undefined {
  if (value === undefined) {
    return;
  }
  const resolved = typeof value === "number" ? value : parseDuration(value);
  if (
    !Number.isFinite(resolved) ||
    resolved <= 0 ||
    resolved > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      "ai-router: timeout durations must be positive and at most 24h"
    );
  }
  // Node and browsers truncate fractional timer delays. Round up so a
  // positive timeout can never become an accidental immediate timeout.
  return Math.ceil(resolved);
}

export function effectiveTimeout(
  attemptTimeout: number | undefined,
  remaining: number | undefined
): number | undefined {
  if (attemptTimeout === undefined) {
    return remaining;
  }
  if (remaining === undefined) {
    return attemptTimeout;
  }
  return Math.min(attemptTimeout, remaining);
}

export async function jitteredBackoff(
  maximumMs: number | undefined,
  signal?: AbortSignal
): Promise<void> {
  if (maximumMs === undefined || maximumMs <= 0) {
    return;
  }
  if (isSignalAborted(signal)) {
    throw signalAbortReason(signal);
  }
  const delay = Math.floor(randomUnit() * maximumMs);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let removeSignalAbort: (() => void) | undefined;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimerSafely(timer);
      removeSignalAbort?.();
      reject(signalAbortReason(signal));
    };
    const timer = scheduleTimer(() => {
      if (settled) {
        return;
      }
      settled = true;
      removeSignalAbort?.();
      resolve();
    }, delay);
    if (settled) {
      return;
    }
    try {
      if (signal !== undefined) {
        removeSignalAbort = addCapturedAbortListener(signal, onAbort);
        if (settled) {
          removeSignalAbort();
          return;
        }
      }
      if (isSignalAborted(signal)) {
        onAbort();
      }
    } catch (error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimerSafely(timer);
      removeSignalAbort?.();
      reject(error);
    }
  });
}
