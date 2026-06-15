import { isAbortError } from "@ai-sdk/provider-utils";

import type { ShouldRetryThisError } from "./types";

export type { ShouldRetryThisError } from "./types";

/**
 * Status codes that are positively RETRYABLE (transient/capacity/auth-refresh
 * conditions where another provider may succeed). Mirrors `ai-fallback`.
 * In addition, any status `>= 500` is retryable.
 */
const RETRYABLE_STATUS = new Set([401, 403, 408, 409, 413, 429, 498]);

/** Only accept a finite number — never coerce a numeric string (e.g. 'ECONNRESET'). */
function pickNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Extract just the numeric HTTP status the classifier needs — without the
 * `message` normalization (and its `JSON.stringify`) that the default
 * classifier never reads.
 */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return;
  }
  const e = error as Record<string, unknown>;
  return pickNumber(e.statusCode ?? e.status);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Reduce an unknown error to the two things the classifier reasons about: a
 * numeric `statusCode` (when present) and a lowercased `message` to pattern-match.
 *
 * The `error` field of a v4 stream error part is typed `unknown` and the
 * openai-compatible provider may deliver an `Error`, a plain string, or an
 * arbitrary object — so this must cope with all of them.
 */
export function normalizeError(error: unknown): {
  statusCode?: number;
  message: string;
} {
  if (error == null) {
    return { message: "" };
  }
  if (typeof error === "string") {
    return { message: error.toLowerCase() };
  }
  if (typeof error === "object") {
    const e = error as Record<string, unknown>;
    const statusCode = pickNumber(e.statusCode ?? e.status);
    const message =
      typeof e.message === "string" && e.message.length > 0
        ? e.message.toLowerCase()
        : safeStringify(error).toLowerCase();
    return statusCode == null ? { message } : { statusCode, message };
  }
  return { message: String(error).toLowerCase() };
}

/**
 * Default classifier. Returns `true` to retry (fall through to the next
 * candidate), `false` to stop and surface the error.
 *
 * Decision order, driven by the numeric `statusCode` when one is present:
 *  1. An abort/timeout (the caller's `abortSignal` fired, or a `TimeoutError`)
 *     -> stop. Retrying another candidate with the same aborted signal is
 *     pointless and would swallow the caller's intent.
 *  2. A positively-retryable status (`RETRYABLE_STATUS` or `>= 500`) -> retry.
 *  3. A 4xx client error NOT in the retryable set (e.g. 400/404/422) -> stop.
 *     This is the key P0-B behavior: a genuine bad-request (which carries a
 *     numeric `statusCode`, e.g. the AI SDK's `APICallError`) does not burn
 *     through every candidate.
 *  4. Otherwise -> retry. A generic thrown error with no recognizable status is
 *     treated as a transient/unknown failure. This reproduces the router's
 *     historical "retry on any thrown error" behavior.
 *
 * Note: classification is intentionally status-based. A client error surfaced
 * only as a message string (no `statusCode`) is treated as unknown -> retried.
 * Callers wanting message-based or stricter policies should pass a custom
 * {@link ShouldRetryThisError} (and may call this as a fallback).
 */
export function defaultShouldRetryThisError(error: unknown): boolean {
  // A caller-initiated abort / timeout must not fan out to other candidates.
  if (isAbortError(error)) {
    return false;
  }

  const statusCode = statusCodeOf(error);

  if (statusCode != null) {
    if (RETRYABLE_STATUS.has(statusCode) || statusCode >= 500) {
      return true;
    }
    if (statusCode >= 400 && statusCode < 500) {
      return false;
    }
  }

  return true;
}

/** Resolve the classifier to use: the caller's hook, or the default. */
export function resolveShouldRetry(
  hook?: ShouldRetryThisError
): ShouldRetryThisError {
  return hook ?? defaultShouldRetryThisError;
}

/** Run a classifier defensively — a throw inside it degrades to "do not retry". */
export function safeShouldRetry(
  shouldRetry: ShouldRetryThisError,
  error: unknown
): boolean {
  try {
    return shouldRetry(error);
  } catch {
    return false;
  }
}

/**
 * Build the error to surface when every candidate has failed.
 *
 *  - 0 errors (defensive; unreachable in practice) -> a generic Error.
 *  - 1 error -> that error verbatim (identity preserved for the common case).
 *  - many -> an `AggregateError` whose `.errors` holds every candidate error and
 *    whose `.message` embeds the last error's message.
 */
export function surfaceFailure(errors: unknown[], logicalId: string): unknown {
  if (errors.length === 0) {
    return new Error(`ai-router: all candidates for "${logicalId}" failed`);
  }
  if (errors.length === 1) {
    return errors[0];
  }
  const last = errors.at(-1);
  const lastMessage =
    last != null &&
    typeof last === "object" &&
    typeof (last as { message?: unknown }).message === "string"
      ? (last as { message: string }).message
      : String(last);
  return new AggregateError(
    errors,
    `ai-router: all ${errors.length} candidates for "${logicalId}" failed; last error: ${lastMessage}`
  );
}
