import { consumeGenuinePromise } from "./runtime-types";
import type { RetryBudgetConfig } from "./types";

const WINDOW_COMPACTION_PREFIX = 1024;

export interface RetryBudgetState {
  available: boolean;
  failureRate: number;
  failures: number;
  samples: number;
  tripped: boolean;
  windowMs: number;
}

export class RetryBudget {
  private readonly window: Array<{ at: number; success: boolean }> = [];
  private windowStart = 0;
  private failures = 0;
  private tripped = false;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxSamples: number;
  private readonly minSamples: number;
  private readonly recoveryFailureRate: number;
  private readonly tripFailureRate: number;
  private lastNow?: number;

  constructor(
    now: () => number = Date.now,
    windowMs = 60_000,
    config: Omit<RetryBudgetConfig, "window"> = {}
  ) {
    const maxSamples = config.maxSamples ?? 20;
    const minSamples = config.minSamples ?? 5;
    const tripFailureRate = config.tripFailureRate ?? 0.8;
    const recoveryFailureRate = config.recoveryFailureRate ?? 0.4;
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new Error(
        "ai-router: retry budget window must be a positive safe integer"
      );
    }
    if (
      !(Number.isInteger(minSamples) && Number.isInteger(maxSamples)) ||
      minSamples < 1 ||
      maxSamples < minSamples ||
      maxSamples > 10_000
    ) {
      throw new Error(
        "ai-router: retry budget samples require 1 <= minSamples <= maxSamples <= 10000"
      );
    }
    if (
      !(
        Number.isFinite(recoveryFailureRate) && Number.isFinite(tripFailureRate)
      ) ||
      recoveryFailureRate < 0 ||
      tripFailureRate <= 0 ||
      recoveryFailureRate > tripFailureRate ||
      tripFailureRate > 1
    ) {
      throw new Error(
        "ai-router: retry budget rates require 0 <= recoveryFailureRate <= tripFailureRate <= 1 and tripFailureRate > 0"
      );
    }
    this.now = now;
    this.windowMs = windowMs;
    this.maxSamples = maxSamples;
    this.minSamples = minSamples;
    this.recoveryFailureRate = recoveryFailureRate;
    this.tripFailureRate = tripFailureRate;
  }

  available(): boolean {
    this.refresh();
    return !this.tripped;
  }

  observe(success: boolean): void {
    const now = this.currentTime();
    this.prune(now);
    this.window.push({ at: now, success });
    if (!success) {
      this.failures += 1;
    }
    if (this.sampleCount() > this.maxSamples) {
      this.removeOldest();
      this.compactWindow();
    }
    if (this.sampleCount() < this.minSamples) {
      return;
    }
    const failureRate = this.failureRate();
    this.tripped = this.tripped
      ? this.remainsTripped(failureRate)
      : failureRate >= this.tripFailureRate;
  }

  snapshot(): RetryBudgetState {
    this.refresh();
    const samples = this.sampleCount();
    return {
      available: !this.tripped,
      failureRate: samples === 0 ? 0 : this.failures / samples,
      failures: this.failures,
      samples,
      tripped: this.tripped,
      windowMs: this.windowMs,
    };
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.window[this.windowStart]?.at < cutoff) {
      this.removeOldest();
    }
    this.compactWindow();
  }

  private failureRate(): number {
    return this.failures / this.sampleCount();
  }

  private sampleCount(): number {
    return this.window.length - this.windowStart;
  }

  private removeOldest(): void {
    const oldest = this.window[this.windowStart];
    if (oldest === undefined) {
      return;
    }
    if (!oldest.success) {
      this.failures -= 1;
    }
    this.windowStart += 1;
  }

  private compactWindow(): void {
    if (
      this.windowStart < WINDOW_COMPACTION_PREFIX ||
      this.windowStart * 2 < this.window.length
    ) {
      return;
    }
    this.window.splice(0, this.windowStart);
    this.windowStart = 0;
  }

  private remainsTripped(failureRate: number): boolean {
    return this.recoveryFailureRate === 0
      ? failureRate > 0
      : failureRate >= this.recoveryFailureRate;
  }

  private refresh(): void {
    this.prune(this.currentTime());
    if (this.sampleCount() < this.minSamples) {
      this.tripped = false;
      return;
    }
    const failureRate = this.failureRate();
    this.tripped = this.tripped
      ? this.remainsTripped(failureRate)
      : failureRate >= this.tripFailureRate;
  }

  private currentTime(): number {
    let current: number;
    try {
      current = this.now();
      if (consumeGenuinePromise(current)) {
        throw new Error("async retry-budget clock is unsupported");
      }
    } catch {
      return this.lastNow ?? 0;
    }
    if (!Number.isSafeInteger(current) || current < 0) {
      return this.lastNow ?? 0;
    }
    if (this.lastNow !== undefined && current < this.lastNow) {
      const adjustment = current - this.lastNow;
      for (let index = this.windowStart; index < this.window.length; index++) {
        const sample = this.window[index];
        if (sample !== undefined) {
          sample.at += adjustment;
        }
      }
    }
    this.lastNow = current;
    return current;
  }
}
