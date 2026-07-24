import { describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../admission";
import { AdmissionRegistry } from "../admission-utils";

describe("AdmissionController", () => {
  it("skips an expired FIFO head after an AIMD increase", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout"] });
    try {
      const admission = new AdmissionController(
        [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 1,
              initial: 1,
              max: 2,
              min: 1,
            },
          },
        ],
        5
      );
      expect(admission.acquire(0)).toBe(1);
      const expiredHead = admission.waitFor(0, undefined, undefined);
      await vi.advanceTimersByTimeAsync(3);
      const survivingTail = admission.waitFor(0, undefined, undefined);
      expect(admission.snapshot(0).waiting).toBe(2);
      await vi.advanceTimersByTimeAsync(2);

      await expect(expiredHead).resolves.toBeUndefined();
      expect(admission.snapshot(0).waiting).toBe(1);
      admission.observe(0, true);
      admission.release(0);

      await expect(survivingTail).resolves.toBe(1);
      expect(admission.snapshot(0)).toMatchObject({
        inFlight: 1,
        limit: 2,
        waiting: 0,
      });
      admission.release(0);
      expect(admission.inFlight(0)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles release and abort races without leaking or revoking slots", async () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );

    expect(admission.acquire(0)).toBe(1);
    const releaseFirstController = new AbortController();
    const releaseFirst = admission.waitFor(
      0,
      releaseFirstController.signal,
      undefined
    );
    admission.release(0);
    releaseFirstController.abort(new Error("late abort"));
    await expect(releaseFirst).resolves.toBe(1);
    expect(admission.inFlight(0)).toBe(1);
    admission.release(0);

    expect(admission.acquire(0)).toBe(1);
    const abortFirstController = new AbortController();
    const abortFirst = admission.waitFor(
      0,
      abortFirstController.signal,
      undefined
    );
    abortFirstController.abort(new Error("early abort"));
    admission.release(0);
    await expect(abortFirst).rejects.toThrow("early abort");
    expect(admission.inFlight(0)).toBe(0);
    expect(registry.waiters.size).toBe(0);
  });

  it("ignores a retained abort listener after cleanup fails on grant", async () => {
    let aborted = false;
    let listener: (() => void) | undefined;
    const reason = new Error("late retained abort");
    const signal = {
      addEventListener(_name: string, nextListener: () => void) {
        listener = nextListener;
      },
      get aborted() {
        return aborted;
      },
      reason,
      removeEventListener() {
        throw new Error("listener cleanup unavailable");
      },
    } as unknown as AbortSignal;
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    expect(admission.acquire(0)).toBe(1);
    const waiting = admission.waitFor(0, signal, undefined);

    admission.release(0);
    await expect(waiting).resolves.toBe(1);
    expect(admission.snapshot(0)).toMatchObject({
      inFlight: 1,
      waiting: 0,
    });

    aborted = true;
    listener?.();
    await expect(waiting).resolves.toBe(1);
    expect(admission.snapshot(0)).toMatchObject({
      inFlight: 1,
      waiting: 0,
    });

    admission.release(0);
    expect(admission.inFlight(0)).toBe(0);
    expect(registry.waiters.size).toBe(0);
  });

  it("does not miss an abort that happens during listener registration", async () => {
    const reason = new Error("aborted while subscribing");
    let aborted = false;
    const signal = {
      addEventListener() {
        aborted = true;
      },
      get aborted() {
        return aborted;
      },
      reason,
      removeEventListener() {
        // Registration is synthetic; there is no backing listener collection.
      },
    } as unknown as AbortSignal;
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );

    await expect(admission.waitFor(0, signal, undefined)).rejects.toBe(reason);
    expect(registry.waiters.size).toBe(0);
  });

  it("removes a waiter when abort-listener registration throws", async () => {
    const failure = new Error("listener registration failed");
    const signal = {
      aborted: false,
      addEventListener() {
        throw failure;
      },
      removeEventListener() {
        // Registration failed before there was a listener to remove.
      },
    } as unknown as AbortSignal;
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );

    await expect(admission.waitFor(0, signal, undefined)).rejects.toBe(failure);
    expect(registry.waiters.size).toBe(0);
  });

  it("preserves registration failure when rollback delivers the listener", async () => {
    const failure = new Error("listener registration failed");
    let registered: (() => void) | undefined;
    const signal = {
      aborted: false,
      addEventListener(_name: string, listener: () => void) {
        registered = listener;
        throw failure;
      },
      removeEventListener(_name: string, listener: () => void) {
        expect(listener).toBe(registered);
        listener();
      },
    } as unknown as AbortSignal;
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );

    await expect(admission.waitFor(0, signal, undefined)).rejects.toBe(failure);
    expect(registry.waiters.size).toBe(0);
    expect(admission.inFlight(0)).toBe(0);
  });
});
