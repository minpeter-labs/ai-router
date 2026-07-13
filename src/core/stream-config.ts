import type { LanguageModelV4StreamResult } from "@ai-sdk/provider";
import { cloneInitialCallOptions } from "./call-options";
/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */
import { MAX_STREAM_DURATION_MS } from "./stream-part-fields";
import type { FallbackStreamArgs } from "./stream-types";

export type FallbackPumpConfig = Pick<
  FallbackStreamArgs,
  | "attemptsStarted"
  | "attemptTimeout"
  | "backoff"
  | "budgetFailureObserved"
  | "budgetSuppressed"
  | "firstContentTimeout"
  | "firstResult"
  | "logicalId"
  | "maxAttempts"
  | "options"
  | "priorErrors"
  | "retryAfterOutput"
  | "startAttemptStartedAt"
  | "startIndex"
  | "startInFlight"
  | "startOrderingToken"
  | "strictStreamValidation"
  | "totalDeadline"
  | "totalTimeout"
>;

export function snapshotFallbackPumpConfig(
  source: FallbackStreamArgs,
  candidateCount: number,
  firstResult: LanguageModelV4StreamResult
): FallbackPumpConfig {
  const config = {
    attemptsStarted: Reflect.get(source, "attemptsStarted"),
    attemptTimeout: Reflect.get(source, "attemptTimeout"),
    backoff: Reflect.get(source, "backoff"),
    budgetFailureObserved: Reflect.get(source, "budgetFailureObserved"),
    budgetSuppressed: Reflect.get(source, "budgetSuppressed"),
    firstContentTimeout: Reflect.get(source, "firstContentTimeout"),
    firstResult,
    logicalId: Reflect.get(source, "logicalId"),
    maxAttempts: Reflect.get(source, "maxAttempts"),
    options: Reflect.get(source, "options"),
    priorErrors: Reflect.get(source, "priorErrors"),
    retryAfterOutput: Reflect.get(source, "retryAfterOutput"),
    startAttemptStartedAt: Reflect.get(source, "startAttemptStartedAt"),
    startIndex: Reflect.get(source, "startIndex"),
    startInFlight: Reflect.get(source, "startInFlight"),
    startOrderingToken: Reflect.get(source, "startOrderingToken"),
    strictStreamValidation: Reflect.get(source, "strictStreamValidation"),
    totalDeadline: Reflect.get(source, "totalDeadline"),
    totalTimeout: Reflect.get(source, "totalTimeout"),
  } as FallbackPumpConfig;
  const optionalDuration = (name: string, value: unknown): void => {
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > MAX_STREAM_DURATION_MS)
    ) {
      throw new TypeError(
        `ai-router: stream ${name} must be positive and at most 24h`
      );
    }
  };
  for (const [name, value] of [
    ["attemptTimeout", config.attemptTimeout],
    ["backoff", config.backoff],
    ["firstContentTimeout", config.firstContentTimeout],
    ["totalTimeout", config.totalTimeout],
  ] as const) {
    optionalDuration(name, value);
  }
  const positiveSafeInteger = (name: string, value: unknown): void => {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    ) {
      throw new TypeError(
        `ai-router: stream ${name} must be a positive safe integer`
      );
    }
  };
  positiveSafeInteger("attemptsStarted", config.attemptsStarted);
  positiveSafeInteger("maxAttempts", config.maxAttempts);
  positiveSafeInteger("startInFlight", config.startInFlight);
  if (
    typeof config.startIndex !== "number" ||
    !Number.isSafeInteger(config.startIndex) ||
    config.startIndex < 0 ||
    config.startIndex >= candidateCount
  ) {
    throw new TypeError(
      "ai-router: stream startIndex must identify a candidate"
    );
  }
  for (const [name, value] of [
    ["budgetFailureObserved", config.budgetFailureObserved],
    ["budgetSuppressed", config.budgetSuppressed],
    ["strictStreamValidation", config.strictStreamValidation],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypeError(`ai-router: stream ${name} must be a boolean`);
    }
  }
  if (typeof config.retryAfterOutput !== "boolean") {
    throw new TypeError("ai-router: stream retryAfterOutput must be a boolean");
  }
  if (
    typeof config.logicalId !== "string" ||
    config.logicalId.length < 1 ||
    config.logicalId.length > 256
  ) {
    throw new TypeError(
      "ai-router: stream logicalId must contain 1-256 characters"
    );
  }
  for (const [name, value] of [
    ["firstResult", config.firstResult],
    ["options", config.options],
  ] as const) {
    if (typeof value !== "object" || value === null) {
      throw new TypeError(`ai-router: stream ${name} must be an object`);
    }
  }
  config.options = cloneInitialCallOptions(config.options);
  for (const [name, value] of [
    ["startAttemptStartedAt", config.startAttemptStartedAt],
    ["totalDeadline", config.totalDeadline],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new TypeError(`ai-router: stream ${name} must be a finite number`);
    }
  }
  return config;
}

/**
 * Wrap a stream result so a mid-stream failure transparently falls back to the
 * next candidate. The `request`/`response` metadata getters track whichever
 * candidate is producing the live stream — best-effort, since a consumer that
 * snapshots them at stream-open (as the AI SDK does) keeps the first candidate's
 * values across a later fallback.
 */
