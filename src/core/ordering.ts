import { consumeGenuinePromise } from "./runtime-types";
import type { RouterOrderingToken } from "./types";

const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
let fallbackOrderingIdCounter = 0;

function createOrderingId(): string {
  try {
    const value = crypto.randomUUID();
    if (consumeGenuinePromise(value)) {
      throw new Error("async UUID entropy is unsupported");
    }
    if (typeof value === "string" && value.length >= 16) {
      return value.replaceAll("-", "").slice(0, 16);
    }
  } catch {
    // Continue to process-local entropy and finally a deterministic counter.
  }
  try {
    const first = Math.random();
    const second = Math.random();
    const asyncFirst = consumeGenuinePromise(first);
    const asyncSecond = consumeGenuinePromise(second);
    if (
      !(asyncFirst || asyncSecond) &&
      Number.isFinite(first) &&
      first >= 0 &&
      first < 1 &&
      Number.isFinite(second) &&
      second >= 0 &&
      second < 1
    ) {
      return `${first.toString(36).slice(2, 10)}${second
        .toString(36)
        .slice(2, 10)}`.padEnd(16, "0");
    }
  } catch {
    // A hostile random source cannot prevent ordering-source construction.
  }
  fallbackOrderingIdCounter =
    fallbackOrderingIdCounter >= Number.MAX_SAFE_INTEGER
      ? 1
      : fallbackOrderingIdCounter + 1;
  return `local${fallbackOrderingIdCounter.toString(36)}`.padEnd(16, "0");
}

export class OrderingTokenSource {
  readonly orderingId = createOrderingId();
  lastOrderingMs = 0;
  orderingCounter = 0;

  next(): RouterOrderingToken {
    let wallClock = this.lastOrderingMs;
    try {
      const sampled = Date.now();
      if (consumeGenuinePromise(sampled)) {
        throw new Error("async ordering clock is unsupported");
      }
      if (
        Number.isSafeInteger(sampled) &&
        sampled >= 0 &&
        sampled <= MAX_DATE_TIMESTAMP_MS
      ) {
        wallClock = sampled;
      }
    } catch {
      // Continue the logical counter when the wall clock is unavailable.
    }
    if (wallClock > this.lastOrderingMs) {
      this.lastOrderingMs = wallClock;
      this.orderingCounter = 0;
    } else if (this.orderingCounter >= 999_999) {
      this.lastOrderingMs += 1;
      this.orderingCounter = 0;
    } else {
      this.orderingCounter += 1;
    }
    return [
      "v1",
      String(this.lastOrderingMs).padStart(13, "0"),
      this.orderingId,
      String(this.orderingCounter).padStart(6, "0"),
    ].join(":");
  }
}
