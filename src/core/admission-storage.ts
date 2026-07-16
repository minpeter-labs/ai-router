import {
  type AdaptiveState,
  type AdmissionEntry,
  AdmissionRegistry,
  MAX_WAITERS_PER_KEY,
  normalizedAdaptiveState,
  type Waiter,
} from "./admission-utils";

export class AdmissionStorage {
  protected readonly entries: AdmissionEntry[];
  protected readonly scope: string;
  protected readonly waitTimeout?: number;
  protected readonly registry: AdmissionRegistry;
  protected readonly roundRobinCursors = new Map<string, number>();
  protected roundRobinPoolKeyChars = 0;

  constructor(
    entries: AdmissionEntry[],
    waitTimeout?: number,
    scope = "default",
    registry = new AdmissionRegistry()
  ) {
    if (
      waitTimeout !== undefined &&
      (!Number.isSafeInteger(waitTimeout) ||
        waitTimeout <= 0 ||
        waitTimeout > 86_400_000)
    ) {
      throw new Error(
        "ai-router: admission wait timeout must be a positive safe duration at most 24h"
      );
    }
    this.entries = entries;
    this.waitTimeout = waitTimeout;
    this.scope = scope;
    this.registry = registry;
    this.registerSharedConfigurations();
  }

  protected key(index: number): string {
    return this.entries[index].healthKey === undefined
      ? `${this.scope}:unit:${index}`
      : `credential:${this.entries[index].healthKey}`;
  }

  protected normalizedInFlight(key: string): number {
    const value = this.registry.inFlightCounts.get(key);
    if (value === undefined) {
      return 0;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      this.registry.inFlightCounts.delete(key);
      return 0;
    }
    return value;
  }

  protected normalizedWaiters(key: string): Waiter[] | undefined {
    const value = this.registry.waiters.get(key);
    if (value === undefined) {
      return;
    }
    try {
      if (!Array.isArray(value)) {
        this.registry.waiters.delete(key);
        return;
      }
      const length = Reflect.get(value, "length");
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_WAITERS_PER_KEY
      ) {
        this.registry.waiters.delete(key);
        return;
      }
      const snapshot = new Array<Waiter>(length);
      for (let index = 0; index < length; index += 1) {
        snapshot[index] = Reflect.get(value, index);
      }
      this.registry.waiters.set(key, snapshot);
      return snapshot;
    } catch {
      this.registry.waiters.delete(key);
      return;
    }
  }

  protected adaptiveState(index: number): AdaptiveState {
    const key = this.key(index);
    const existing = this.registry.adaptiveStates.get(key);
    const normalized = normalizedAdaptiveState(existing);
    if (normalized !== undefined) {
      if (normalized !== existing) {
        this.registry.adaptiveStates.set(key, normalized);
      }
      return normalized;
    }
    if (existing !== undefined) {
      this.registry.adaptiveStates.delete(key);
    }
    const entry = this.entries[index];
    const config =
      typeof entry.adaptiveConcurrency === "object"
        ? entry.adaptiveConcurrency
        : {};
    const min = config.min ?? 1;
    const max = config.max ?? Math.max(entry.maxConcurrency ?? 1, 16);
    const state: AdaptiveState = {
      increaseAfterSuccesses: config.increaseAfterSuccesses ?? 10,
      limit: Math.min(
        max,
        Math.max(min, config.initial ?? entry.maxConcurrency ?? min)
      ),
      max,
      min,
      successes: 0,
    };
    this.registry.adaptiveStates.set(key, state);
    return state;
  }

  protected registerSharedConfigurations(): void {
    for (const [index, entry] of this.entries.entries()) {
      if (entry.healthKey === undefined) {
        continue;
      }
      const key = this.key(index);
      const signature = this.configurationSignature(entry);
      const existing = this.registry.configurations.get(key);
      if (existing !== undefined && existing !== signature) {
        throw new Error(
          `ai-router: candidates sharing healthKey "${entry.healthKey}" must use identical concurrency settings`
        );
      }
      this.registry.configurations.set(key, signature);
    }
  }

  protected configurationSignature(entry: AdmissionEntry): string {
    if (
      entry.adaptiveConcurrency === undefined ||
      entry.adaptiveConcurrency === false
    ) {
      return `fixed:${entry.maxConcurrency ?? "unbounded"}`;
    }
    const config =
      typeof entry.adaptiveConcurrency === "object"
        ? entry.adaptiveConcurrency
        : {};
    const min = config.min ?? 1;
    const max = config.max ?? Math.max(entry.maxConcurrency ?? 1, 16);
    return [
      "adaptive",
      config.initial ?? entry.maxConcurrency ?? min,
      min,
      max,
      config.increaseAfterSuccesses ?? 10,
    ].join(":");
  }
}
