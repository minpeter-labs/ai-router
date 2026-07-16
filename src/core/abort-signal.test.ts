import { describe, expect, it } from "vitest";
import {
  addCapturedAbortListener,
  captureAbortSignalOperations,
} from "./abort-signal";

describe("captured abort signal operations", () => {
  it("reads methods once, preserves receivers, and reuses them for cleanup", () => {
    const listeners = new Set<() => void>();
    const reads = { add: 0, remove: 0 };
    const signal = {
      aborted: false,
      listeners,
      get addEventListener() {
        reads.add += 1;
        return function add(
          this: typeof signal,
          _type: string,
          listener: () => void
        ) {
          this.listeners.add(listener);
        };
      },
      get removeEventListener() {
        reads.remove += 1;
        return function remove(
          this: typeof signal,
          _type: string,
          listener: () => void
        ) {
          this.listeners.delete(listener);
        };
      },
    };
    Object.defineProperties(signal, {
      addEventListener: {
        configurable: true,
        get: Object.getOwnPropertyDescriptor(signal, "addEventListener")?.get,
      },
      removeEventListener: {
        configurable: true,
        get: Object.getOwnPropertyDescriptor(signal, "removeEventListener")
          ?.get,
      },
    });
    captureAbortSignalOperations(signal);
    Object.defineProperties(signal, {
      addEventListener: {
        value: () => {
          throw new Error("mutated add");
        },
      },
      removeEventListener: {
        value: () => {
          throw new Error("mutated remove");
        },
      },
    });
    const listener = () => undefined;
    const cleanup = addCapturedAbortListener(signal as never, listener);

    expect(listeners.size).toBe(1);
    cleanup();
    cleanup();
    expect(listeners.has(listener)).toBe(false);
    expect(reads).toEqual({ add: 1, remove: 1 });
  });

  it("ignores synchronous listener delivery during cleanup", () => {
    let registered: (() => void) | undefined;
    let deliveries = 0;
    const signal = {
      addEventListener(_type: string, listener: () => void) {
        registered = listener;
      },
      removeEventListener(_type: string, listener: () => void) {
        expect(listener).toBe(registered);
        listener();
      },
    };
    const cleanup = addCapturedAbortListener(signal as never, () => {
      deliveries += 1;
    });

    cleanup();
    registered?.();

    expect(deliveries).toBe(0);
  });

  it("delivers at most once when a non-conforming signal repeats abort", () => {
    let registered: (() => void) | undefined;
    let deliveries = 0;
    const signal = {
      addEventListener(_type: string, listener: () => void) {
        registered = listener;
        listener();
        listener();
      },
      removeEventListener() {
        // The helper still attempts normal cleanup after synchronous delivery.
      },
    };

    const cleanup = addCapturedAbortListener(signal as never, () => {
      deliveries += 1;
    });
    registered?.();
    cleanup();
    registered?.();

    expect(deliveries).toBe(1);
  });

  it("rolls back registration when add throws after attaching", () => {
    const listeners = new Set<() => void>();
    const signal = {
      aborted: false,
      addEventListener(_type: string, listener: () => void) {
        listeners.add(listener);
        throw new Error("registration failed");
      },
      removeEventListener(_type: string, listener: () => void) {
        listeners.delete(listener);
      },
    };
    const listener = () => undefined;

    expect(() => addCapturedAbortListener(signal as never, listener)).toThrow(
      "registration failed"
    );
    expect(listeners.size).toBe(0);
  });

  it("consumes async listener results without reading thenables", async () => {
    expect(() =>
      captureAbortSignalOperations(
        Promise.reject(new Error("async abort signal"))
      )
    ).toThrow("synchronous");
    expect(() =>
      captureAbortSignalOperations({
        addEventListener: Promise.reject(new Error("async add slot")),
        removeEventListener: Promise.reject(new Error("async remove slot")),
      })
    ).toThrow("AbortSignal");

    const listeners = new Set<() => void>();
    const signal = {
      addEventListener(_type: string, listener: () => void) {
        listeners.add(listener);
        return Promise.reject(new Error("async listener registration"));
      },
      removeEventListener(_type: string, listener: () => void) {
        listeners.delete(listener);
        return Promise.reject(new Error("async listener cleanup"));
      },
    };

    expect(() =>
      addCapturedAbortListener(signal as never, () => undefined)
    ).toThrow("synchronous");
    expect(listeners.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    const extensionSignal = {
      addEventListener() {
        return thenable;
      },
      removeEventListener() {
        return thenable;
      },
    };
    const cleanup = addCapturedAbortListener(
      extensionSignal as never,
      () => undefined
    );
    cleanup();
    expect(thenReads).toBe(0);
  });

  it("consumes Promise-valued method siblings before an accessor fails", async () => {
    const signal = Object.defineProperties(
      {},
      {
        addEventListener: {
          get() {
            throw new Error("add accessor failed");
          },
        },
        removeEventListener: {
          value: Promise.reject(new Error("async remove sibling")),
        },
      }
    );

    expect(() => captureAbortSignalOperations(signal)).toThrow(
      "add accessor failed"
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
