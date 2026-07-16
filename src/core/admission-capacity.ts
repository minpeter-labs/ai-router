import { addCapturedAbortListener } from "./abort-signal";
import { AdmissionStorage } from "./admission-storage";
import {
  abortReason,
  captureUsableWaiter,
  isSignalAborted,
  isValidWaiterSlot,
  MAX_WAITERS_PER_KEY,
  type Waiter,
} from "./admission-utils";
import { consumeGenuinePromise } from "./runtime-types";
import { clearTimerSafely, monotonicNow, scheduleTimer } from "./timeout";

export class AdmissionCapacity extends AdmissionStorage {
  acquire(index: number): number | undefined {
    const limit = this.limit(index);
    const key = this.key(index);
    const current = this.normalizedInFlight(key);
    if (
      current >= Number.MAX_SAFE_INTEGER ||
      (limit !== undefined && current >= limit)
    ) {
      return;
    }
    const next = current + 1;
    this.registry.inFlightCounts.set(key, next);
    return next;
  }

  canAcquire(index: number): boolean {
    return this.canAcquireWithCurrent(index, this.inFlight(index));
  }

  canAcquireAfterRelease(index: number, releasingIndex: number): boolean {
    const current = this.inFlight(index);
    const effectiveCurrent =
      this.key(index) === this.key(releasingIndex) && current > 0
        ? current - 1
        : current;
    return this.canAcquireWithCurrent(index, effectiveCurrent);
  }

  protected canAcquireWithCurrent(index: number, current: number): boolean {
    const limit = this.limit(index);
    return (
      current < Number.MAX_SAFE_INTEGER &&
      (limit === undefined || current < limit)
    );
  }

  release(index: number): void {
    const key = this.key(index);
    const current = this.normalizedInFlight(key);
    if (current === 0) {
      return;
    }
    const next = current - 1;
    if (next === 0) {
      this.registry.inFlightCounts.delete(key);
    } else {
      this.registry.inFlightCounts.set(key, next);
    }

    this.drainWaiters(key);
  }

  protected drainWaiters(key: string): void {
    let queue = this.normalizedWaiters(key);
    while (queue !== undefined) {
      if (queue.length === 0) {
        if (this.registry.waiters.get(key) !== queue) {
          queue = this.normalizedWaiters(key);
          continue;
        }
        break;
      }
      const waiter = queue[0] as unknown;
      const capturedWaiter = captureUsableWaiter(waiter);
      if (capturedWaiter === undefined) {
        queue.shift();
        continue;
      }
      let slot: number | undefined;
      const beforeAcquire = this.normalizedInFlight(key);
      try {
        slot = capturedWaiter.acquire();
      } catch {
        this.rollbackWaiterAcquire(key, beforeAcquire);
        queue.shift();
        continue;
      }
      if (slot === undefined) {
        this.rollbackWaiterAcquire(key, beforeAcquire);
        break;
      }
      if (!isValidWaiterSlot(slot)) {
        this.rollbackWaiterAcquire(key, beforeAcquire);
        queue.shift();
        continue;
      }
      queue.shift();
      try {
        const result = capturedWaiter.resolve(slot);
        if (result !== undefined) {
          consumeGenuinePromise(result);
          this.rollbackWaiterAcquire(key, beforeAcquire);
        }
      } catch {
        this.rollbackWaiterAcquire(key, beforeAcquire);
      }
    }
    if (queue?.length === 0 && this.registry.waiters.get(key) === queue) {
      this.registry.waiters.delete(key);
    }
  }

  protected rollbackWaiterAcquire(key: string, beforeAcquire: number): void {
    const current = this.normalizedInFlight(key);
    if (current <= beforeAcquire) {
      return;
    }
    const next = current - 1;
    if (next === 0) {
      this.registry.inFlightCounts.delete(key);
    } else {
      this.registry.inFlightCounts.set(key, next);
    }
  }

  waitFor(
    index: number,
    signal: AbortSignal | undefined,
    deadline: number | undefined
  ): Promise<number | undefined> {
    if (this.waitTimeout === undefined) {
      return Promise.resolve(undefined);
    }
    if (deadline !== undefined && Number.isNaN(deadline)) {
      return Promise.resolve(undefined);
    }
    const remaining =
      deadline === undefined || deadline === Number.POSITIVE_INFINITY
        ? this.waitTimeout
        : deadline - monotonicNow();
    // Node and browsers truncate fractional timer delays. Round up so a wait
    // bounded by the total deadline cannot wake a fraction early and surface
    // the preceding provider error instead of the deadline timeout.
    const waitMs = Math.ceil(
      Math.max(0, Math.min(this.waitTimeout, remaining))
    );
    if (isSignalAborted(signal)) {
      return Promise.reject(abortReason(signal));
    }
    if (waitMs === 0) {
      return Promise.resolve(undefined);
    }
    const key = this.key(index);
    const queue = this.normalizedWaiters(key) ?? [];
    if (queue.length >= MAX_WAITERS_PER_KEY) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let removeSignalAbort: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: Waiter = {
        acquire: () => this.acquire(index),
        resolve: (value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimerSafely(timer);
          removeSignalAbort?.();
          resolve(value);
        },
      };
      const remove = () => {
        const currentQueue = this.normalizedWaiters(key);
        if (currentQueue === undefined) {
          return;
        }
        const position = currentQueue.indexOf(entry);
        if (position !== -1) {
          currentQueue.splice(position, 1);
        }
        if (currentQueue.length === 0) {
          this.registry.waiters.delete(key);
        }
      };
      const onAbort = () => {
        remove();
        if (settled) {
          return;
        }
        settled = true;
        clearTimerSafely(timer);
        removeSignalAbort?.();
        reject(abortReason(signal));
      };
      timer = scheduleTimer(() => {
        remove();
        entry.resolve(undefined);
      }, waitMs);
      if (settled) {
        return;
      }
      queue.push(entry);
      this.registry.waiters.set(key, queue);
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
        remove();
        removeSignalAbort?.();
        if (!settled) {
          settled = true;
          clearTimerSafely(timer);
          reject(error);
        }
      }
    });
  }

  inFlight(index: number): number {
    return this.normalizedInFlight(this.key(index));
  }

  limit(index: number): number | undefined {
    const entry = this.entries[index];
    if (
      entry.adaptiveConcurrency === undefined ||
      entry.adaptiveConcurrency === false
    ) {
      return entry.maxConcurrency;
    }
    return this.adaptiveState(index).limit;
  }
}
