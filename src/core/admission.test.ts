import { describe, expect, it, vi } from "vitest";
import { AdmissionController, AdmissionRegistry } from "./admission";

describe("AdmissionController", () => {
  it("acquires up to the limit and wakes queued callers in FIFO order", async () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    expect(admission.canAcquire(0)).toBe(true);
    expect(admission.acquire(0)).toBe(1);
    expect(admission.canAcquire(0)).toBe(false);
    expect(admission.acquire(0)).toBeUndefined();

    const first = admission.waitFor(0, undefined, undefined);
    const second = admission.waitFor(0, undefined, undefined);
    admission.release(0);
    expect(await first).toBe(1);

    admission.release(0);
    expect(await second).toBe(1);
    admission.release(0);
    expect(admission.inFlight(0)).toBe(0);
    expect(admission.canAcquire(0)).toBe(true);
    expect(registry.waiters.size).toBe(0);
  });

  it("removes an aborted waiter", async () => {
    const admission = new AdmissionController([{ maxConcurrency: 1 }], 1000);
    admission.acquire(0);
    const controller = new AbortController();
    const waiting = admission.waitFor(0, controller.signal, undefined);
    controller.abort(new Error("cancelled"));

    await expect(waiting).rejects.toThrow("cancelled");
    admission.release(0);
    expect(admission.inFlight(0)).toBe(0);
  });

  it("removes shared-key waiters in reverse cancellation order", async () => {
    const adaptiveConcurrency = { initial: 1, max: 2, min: 1 };
    const admission = new AdmissionController(
      [
        {
          adaptiveConcurrency,
          healthKey: "shared-reverse-cancel",
        },
        {
          adaptiveConcurrency,
          healthKey: "shared-reverse-cancel",
        },
      ],
      1000
    );
    expect(admission.acquire(0)).toBe(1);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = admission.waitFor(0, firstController.signal, undefined);
    const second = admission.waitFor(1, secondController.signal, undefined);
    expect(admission.snapshot(0).waiting).toBe(2);
    expect(admission.snapshot(1).waiting).toBe(2);

    secondController.abort(new Error("cancel second"));
    await expect(second).rejects.toThrow("cancel second");
    expect(admission.snapshot(0).waiting).toBe(1);
    expect(admission.snapshot(1).waiting).toBe(1);

    firstController.abort(new Error("cancel first"));
    await expect(first).rejects.toThrow("cancel first");
    expect(admission.snapshot(0).waiting).toBe(0);
    expect(admission.snapshot(1).waiting).toBe(0);

    admission.release(0);
    expect(admission.acquire(1)).toBe(1);
    expect(admission.snapshot(1)).toMatchObject({
      inFlight: 1,
      limit: 1,
      successes: 0,
      waiting: 0,
    });
    admission.release(1);
    expect(admission.inFlight(0)).toBe(0);
  });

  it("does not revoke a granted shared slot after a sibling waiter cancels", async () => {
    const admission = new AdmissionController(
      [
        { healthKey: "shared-cancel-release", maxConcurrency: 1 },
        { healthKey: "shared-cancel-release", maxConcurrency: 1 },
      ],
      1000
    );
    expect(admission.acquire(0)).toBe(1);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = admission.waitFor(0, firstController.signal, undefined);
    const second = admission.waitFor(1, secondController.signal, undefined);
    expect(admission.snapshot(0).waiting).toBe(2);

    secondController.abort(new Error("cancel sibling"));
    await expect(second).rejects.toThrow("cancel sibling");
    admission.release(0);
    firstController.abort(new Error("late abort after grant"));

    await expect(first).resolves.toBe(1);
    expect(admission.snapshot(0)).toMatchObject({
      inFlight: 1,
      waiting: 0,
    });
    expect(admission.snapshot(1)).toMatchObject({
      inFlight: 1,
      waiting: 0,
    });
    admission.release(1);
    expect(admission.inFlight(0)).toBe(0);
  });

  it("settles multi-waiter release and timeout ordering at the deadline", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout"] });
    try {
      const releasedFirst = new AdmissionController(
        [{ maxConcurrency: 1 }],
        10
      );
      expect(releasedFirst.acquire(0)).toBe(1);
      const granted = releasedFirst.waitFor(0, undefined, undefined);
      const timedOut = releasedFirst.waitFor(0, undefined, undefined);
      await vi.advanceTimersByTimeAsync(9);

      releasedFirst.release(0);
      await expect(granted).resolves.toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(timedOut).resolves.toBeUndefined();
      expect(releasedFirst.snapshot(0)).toMatchObject({
        inFlight: 1,
        waiting: 0,
      });
      releasedFirst.release(0);
      expect(releasedFirst.inFlight(0)).toBe(0);

      const timedOutFirst = new AdmissionController(
        [{ maxConcurrency: 1 }],
        10
      );
      expect(timedOutFirst.acquire(0)).toBe(1);
      const firstTimeout = timedOutFirst.waitFor(0, undefined, undefined);
      const secondTimeout = timedOutFirst.waitFor(0, undefined, undefined);
      await vi.advanceTimersByTimeAsync(10);

      await expect(firstTimeout).resolves.toBeUndefined();
      await expect(secondTimeout).resolves.toBeUndefined();
      timedOutFirst.release(0);
      expect(timedOutFirst.snapshot(0)).toMatchObject({
        inFlight: 0,
        waiting: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps deadline waiters parked after an AIMD decrease", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout"] });
    try {
      const admission = new AdmissionController(
        [
          {
            adaptiveConcurrency: {
              initial: 2,
              max: 2,
              min: 1,
            },
          },
        ],
        10
      );
      expect(admission.acquire(0)).toBe(1);
      expect(admission.acquire(0)).toBe(2);
      const first = admission.waitFor(0, undefined, undefined);
      const second = admission.waitFor(0, undefined, undefined);
      admission.observe(0, false, {
        retryable: true,
        scope: "credential",
        statusCode: 429,
      });
      expect(admission.snapshot(0)).toMatchObject({
        inFlight: 2,
        limit: 1,
        waiting: 2,
      });
      await vi.advanceTimersByTimeAsync(9);

      admission.release(0);
      expect(admission.snapshot(0)).toMatchObject({
        inFlight: 1,
        limit: 1,
        waiting: 2,
      });
      await vi.advanceTimersByTimeAsync(1);

      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBeUndefined();
      expect(admission.snapshot(0)).toMatchObject({
        inFlight: 1,
        limit: 1,
        waiting: 0,
      });
      admission.release(0);
      expect(admission.acquire(0)).toBe(1);
      admission.release(0);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("preserves a delivered abort when listener registration then throws", async () => {
    const reason = new Error("aborted during failed registration");
    let aborted = false;
    const signal = {
      addEventListener(_name: string, listener: () => void) {
        aborted = true;
        listener();
        throw new Error("listener registration failed");
      },
      get aborted() {
        return aborted;
      },
      reason,
      removeEventListener() {
        // Registration rollback has no retained listener.
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
    expect(admission.inFlight(0)).toBe(0);
  });

  it("settles an abort even when reading its reason throws", async () => {
    let aborted = false;
    let removals = 0;
    const signal = {
      addEventListener(_name: string, listener: () => void) {
        aborted = true;
        listener();
      },
      get aborted() {
        return aborted;
      },
      get reason() {
        throw new Error("reason unavailable");
      },
      removeEventListener() {
        removals += 1;
      },
    } as unknown as AbortSignal;
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );

    await expect(admission.waitFor(0, signal, undefined)).rejects.toMatchObject(
      {
        name: "AbortError",
      }
    );
    expect(registry.waiters.size).toBe(0);
    expect(removals).toBe(1);
  });

  it("does not queue or subscribe after a synchronous wait timer fires", async () => {
    let subscriptions = 0;
    const signal = {
      aborted: false,
      addEventListener() {
        subscriptions += 1;
      },
      removeEventListener() {
        // No listener should be installed.
      },
    } as unknown as AbortSignal;
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void
    ) => {
      callback();
      return 1 as never;
    }) as unknown as typeof setTimeout);
    try {
      await expect(
        admission.waitFor(0, signal, undefined)
      ).resolves.toBeUndefined();
      expect(subscriptions).toBe(0);
      expect(registry.waiters.size).toBe(0);
    } finally {
      timer.mockRestore();
    }
  });

  it("treats an unreadable aborted flag as unproven and still admits", async () => {
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "aborted", {
      get() {
        throw new Error("aborted flag unavailable");
      },
    });
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    expect(admission.acquire(0)).toBe(1);

    const waiting = admission.waitFor(0, controller.signal, undefined);
    admission.release(0);

    await expect(waiting).resolves.toBe(1);
    expect(registry.waiters.size).toBe(0);
    admission.release(0);
    expect(admission.inFlight(0)).toBe(0);
  });

  it("times out while waiting for a final slot", async () => {
    vi.useFakeTimers();
    try {
      const admission = new AdmissionController([{ maxConcurrency: 1 }], 50);
      admission.acquire(0);
      const waiting = admission.waitFor(0, undefined, undefined);
      await vi.advanceTimersByTimeAsync(50);
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not truncate a fractional remaining deadline", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout"] });
    try {
      const admission = new AdmissionController([{ maxConcurrency: 1 }], 50);
      admission.acquire(0);
      let settled = false;
      const waiting = admission
        .waitFor(0, undefined, performance.now() + 0.5)
        .then((slot) => {
          settled = true;
          return slot;
        });

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid wait settings and does not queue a NaN deadline", async () => {
    expect(() => new AdmissionController([], Number.NaN)).toThrow(
      "wait timeout"
    );
    expect(
      () => new AdmissionController([], Number.MAX_SAFE_INTEGER + 1)
    ).toThrow("wait timeout");

    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    admission.acquire(0);
    await expect(
      admission.waitFor(0, undefined, Number.NaN)
    ).resolves.toBeUndefined();
    expect(registry.waiters.size).toBe(0);
  });

  it("bounds waiters per shared key and discards malformed queue entries", async () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    admission.acquire(0);
    const fake = { acquire: () => undefined, resolve: () => undefined };
    registry.waiters.set(
      "default:unit:0",
      Array.from({ length: 10_000 }, () => fake)
    );

    await expect(
      admission.waitFor(0, undefined, undefined)
    ).resolves.toBeUndefined();
    expect(admission.snapshot(0).waiting).toBe(10_000);

    registry.waiters.set("default:unit:0", [null as never]);
    expect(() => admission.release(0)).not.toThrow();
    expect(registry.waiters.size).toBe(0);
    expect(admission.inFlight(0)).toBe(0);
  });

  it("skips a malformed head without leaving the granted waiter timer live", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout"] });
    try {
      const registry = new AdmissionRegistry();
      const admission = new AdmissionController(
        [{ maxConcurrency: 1 }],
        10,
        "default",
        registry
      );
      expect(admission.acquire(0)).toBe(1);
      const waiting = admission.waitFor(0, undefined, undefined);
      const queue = registry.waiters.get("default:unit:0");
      expect(queue).toBeDefined();
      queue?.unshift(null as never);
      await vi.advanceTimersByTimeAsync(5);

      admission.release(0);
      await expect(waiting).resolves.toBe(1);
      expect(admission.snapshot(0)).toMatchObject({
        inFlight: 1,
        waiting: 0,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(admission.snapshot(0)).toMatchObject({
        inFlight: 1,
        waiting: 0,
      });

      admission.release(0);
      expect(admission.inFlight(0)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stale wait timer when timer cleanup fails after grant", async () => {
    vi.useFakeTimers({ toFake: ["clearTimeout", "performance", "setTimeout"] });
    let clear: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const admission = new AdmissionController([{ maxConcurrency: 1 }], 10);
      expect(admission.acquire(0)).toBe(1);
      const waiting = admission.waitFor(0, undefined, undefined);
      await vi.advanceTimersByTimeAsync(5);
      clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {
        throw new Error("timer cleanup unavailable");
      });

      admission.release(0);
      await expect(waiting).resolves.toBe(1);
      clear.mockRestore();
      expect(admission.snapshot(0)).toMatchObject({
        inFlight: 1,
        waiting: 0,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(admission.snapshot(0)).toMatchObject({
        inFlight: 1,
        waiting: 0,
      });

      admission.release(0);
      expect(admission.inFlight(0)).toBe(0);
    } finally {
      clear?.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rolls back a slot when a corrupted waiter resolve throws", () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    admission.acquire(0);
    registry.waiters.set("default:unit:0", [
      {
        acquire: () => admission.acquire(0),
        resolve: () => {
          throw new Error("corrupted waiter resolve");
        },
      },
    ]);

    expect(() => admission.release(0)).not.toThrow();
    expect(admission.inFlight(0)).toBe(0);
    expect(registry.waiters.size).toBe(0);
  });

  it("preserves a waiter enqueued reentrantly during settlement", async () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    admission.acquire(0);
    let nested: Promise<number | undefined> | undefined;
    registry.waiters.set("default:unit:0", [
      {
        acquire: () => admission.acquire(0),
        resolve: () => {
          nested = admission.waitFor(0, undefined, undefined);
        },
      },
    ]);

    admission.release(0);
    expect(admission.inFlight(0)).toBe(1);
    expect(admission.snapshot(0).waiting).toBe(1);
    admission.release(0);

    await expect(nested).resolves.toBe(1);
    expect(admission.inFlight(0)).toBe(1);
    admission.release(0);
  });

  it("drains a reentrant waiter after a corrupted settlement rolls back", async () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    admission.acquire(0);
    let nested: Promise<number | undefined> | undefined;
    registry.waiters.set("default:unit:0", [
      {
        acquire: () => admission.acquire(0),
        resolve: () => {
          nested = admission.waitFor(0, undefined, undefined);
          throw new Error("corrupted settlement");
        },
      },
    ]);

    admission.release(0);

    await expect(nested).resolves.toBe(1);
    expect(admission.inFlight(0)).toBe(1);
    expect(registry.waiters.size).toBe(0);
    admission.release(0);
  });

  it("discards oversized or unreadable corrupted waiter queues", () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    expect(admission.acquire(0)).toBe(1);
    const acquire = vi.fn(() => 1);
    registry.waiters.set(
      "default:unit:0",
      Array.from({ length: 10_001 }, () => ({
        acquire,
        resolve: () => undefined,
      }))
    );

    expect(() => admission.release(0)).not.toThrow();
    expect(acquire).not.toHaveBeenCalled();
    expect(registry.waiters.size).toBe(0);

    const unreadable = new Proxy([], {
      get(target, key, receiver) {
        if (key === "length") {
          throw new Error("queue length unavailable");
        }
        return Reflect.get(target, key, receiver);
      },
    });
    registry.waiters.set("default:unit:0", unreadable);
    expect(() => admission.snapshot(0)).not.toThrow();
    expect(registry.waiters.size).toBe(0);

    let lengthReads = 0;
    const nonArray = Object.defineProperty({}, "length", {
      get() {
        lengthReads += 1;
        throw new Error("non-array length must not be read");
      },
    });
    registry.waiters.set("default:unit:0", nonArray as never);
    expect(() => admission.snapshot(0)).not.toThrow();
    expect(lengthReads).toBe(0);
    expect(registry.waiters.size).toBe(0);
  });

  it("snapshots a Proxy waiter queue before mutating it", () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    expect(admission.acquire(0)).toBe(1);
    const resolve = vi.fn();
    const queue = new Proxy(
      [{ acquire: () => admission.acquire(0), resolve }],
      {
        get(target, key, receiver) {
          if (key === "shift" || key === "splice") {
            throw new Error("proxy queue mutation unavailable");
          }
          return Reflect.get(target, key, receiver);
        },
      }
    );
    registry.waiters.set("default:unit:0", queue);

    expect(() => admission.release(0)).not.toThrow();
    expect(resolve).toHaveBeenCalledWith(1);
    expect(registry.waiters.size).toBe(0);
    expect(admission.inFlight(0)).toBe(1);
  });

  it("skips malformed waiter results and still wakes the next FIFO waiter", async () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    admission.acquire(0);
    registry.waiters.set("default:unit:0", [
      {
        acquire: () => {
          admission.acquire(0);
          return Number.NaN;
        },
        resolve: () => undefined,
      },
    ]);
    const survivor = admission.waitFor(0, undefined, undefined);

    admission.release(0);

    await expect(survivor).resolves.toBe(1);
    expect(admission.inFlight(0)).toBe(1);
    admission.release(0);
    expect(admission.inFlight(0)).toBe(0);
  });

  it("consumes async corrupted waiter resolve rejection and rolls back", async () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    admission.acquire(0);
    registry.waiters.set("default:unit:0", [
      {
        acquire: () => admission.acquire(0),
        resolve: (() =>
          Promise.reject(new Error("async corrupted resolve"))) as never,
      },
    ]);

    admission.release(0);
    await Promise.resolve();

    expect(admission.inFlight(0)).toBe(0);
    expect(registry.waiters.size).toBe(0);
  });

  it("hands a rolled-back async corrupted slot to the live FIFO tail", async () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    expect(admission.acquire(0)).toBe(1);
    registry.waiters.set("default:unit:0", [
      {
        acquire: () => admission.acquire(0),
        resolve: (() =>
          Promise.reject(new Error("async corrupted head"))) as never,
      },
    ]);
    const survivor = admission.waitFor(0, undefined, undefined);

    admission.release(0);

    await expect(survivor).resolves.toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(admission.snapshot(0)).toMatchObject({
      inFlight: 1,
      waiting: 0,
    });
    admission.release(0);
    expect(admission.inFlight(0)).toBe(0);
  });

  it("captures corrupted waiter method slots once with their receiver", () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    admission.acquire(0);
    const reads = { acquire: 0, resolve: 0 };
    const waiter = {
      get acquire() {
        reads.acquire += 1;
        return function acquire(this: unknown) {
          expect(this).toBe(waiter);
          return admission.acquire(0);
        };
      },
      get resolve() {
        reads.resolve += 1;
        return function resolve(this: unknown, slot: number | undefined) {
          expect(this).toBe(waiter);
          expect(slot).toBe(1);
        };
      },
    };
    registry.waiters.set("default:unit:0", [waiter]);

    admission.release(0);

    expect(reads).toEqual({ acquire: 1, resolve: 1 });
    expect(admission.inFlight(0)).toBe(1);
    admission.release(0);
  });

  it("consumes Promise-valued corrupted waiter method siblings", async () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ maxConcurrency: 1 }],
      1000,
      "default",
      registry
    );
    admission.acquire(0);
    registry.waiters.set("default:unit:0", [
      Object.defineProperties(
        {},
        {
          acquire: {
            get() {
              throw new Error("acquire unavailable");
            },
          },
          resolve: {
            value: Promise.reject(new Error("async resolve method")),
          },
        }
      ) as never,
    ]);

    expect(() => admission.release(0)).not.toThrow();
    expect(admission.inFlight(0)).toBe(0);
    expect(registry.waiters.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("fills all newly available AIMD capacity in FIFO order", async () => {
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
      1000
    );
    expect(admission.acquire(0)).toBe(1);
    const first = admission.waitFor(0, undefined, undefined);
    const second = admission.waitFor(0, undefined, undefined);

    admission.observe(0, true);
    admission.release(0);

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(admission.inFlight(0)).toBe(2);
    admission.release(0);
    admission.release(0);
  });

  it("does not drain waiters above a newly reduced AIMD limit", async () => {
    const admission = new AdmissionController(
      [
        {
          adaptiveConcurrency: {
            initial: 4,
            max: 4,
            min: 1,
          },
        },
      ],
      1000
    );
    for (let index = 0; index < 4; index += 1) {
      expect(admission.acquire(0)).toBe(index + 1);
    }
    const settled: string[] = [];
    const first = admission.waitFor(0, undefined, undefined).then((slot) => {
      settled.push(`first:${slot}`);
      return slot;
    });
    const second = admission.waitFor(0, undefined, undefined).then((slot) => {
      settled.push(`second:${slot}`);
      return slot;
    });

    admission.observe(0, false, {
      retryable: true,
      scope: "transient",
      statusCode: 503,
    });
    expect(admission.limit(0)).toBe(2);

    admission.release(0);
    admission.release(0);
    await Promise.resolve();
    expect(admission.inFlight(0)).toBe(2);
    expect(settled).toEqual([]);

    admission.release(0);
    await expect(first).resolves.toBe(2);
    expect(settled).toEqual(["first:2"]);
    expect(admission.inFlight(0)).toBe(2);

    admission.release(0);
    await expect(second).resolves.toBe(2);
    expect(settled).toEqual(["first:2", "second:2"]);
    admission.release(0);
    admission.release(0);
  });

  it("does not admit a waiter on an unmatched release", async () => {
    vi.useFakeTimers();
    try {
      const admission = new AdmissionController([{ maxConcurrency: 1 }], 10);
      const waiting = admission.waitFor(0, undefined, undefined);

      admission.release(0);
      await vi.advanceTimersByTimeAsync(10);

      await expect(waiting).resolves.toBeUndefined();
      expect(admission.inFlight(0)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overflow a saturated in-flight counter", () => {
    const registry = new AdmissionRegistry();
    registry.inFlightCounts.set("default:unit:0", Number.MAX_SAFE_INTEGER);
    const admission = new AdmissionController(
      [{}],
      undefined,
      "default",
      registry
    );

    expect(admission.canAcquire(0)).toBe(false);
    expect(admission.acquire(0)).toBeUndefined();
    expect(admission.inFlight(0)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("fails open and repairs malformed shared in-flight counters", () => {
    for (const malformed of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const registry = new AdmissionRegistry();
      registry.inFlightCounts.set("default:unit:0", malformed);
      const admission = new AdmissionController(
        [{ maxConcurrency: 1 }],
        undefined,
        "default",
        registry
      );

      expect(admission.canAcquire(0)).toBe(true);
      expect(admission.acquire(0)).toBe(1);
      expect(admission.snapshot(0).inFlight).toBe(1);
      admission.release(0);
      expect(admission.inFlight(0)).toBe(0);
    }
  });

  it("preflights capacity after a pending release in the same scope", () => {
    const admission = new AdmissionController([
      { healthKey: "shared", maxConcurrency: 1 },
      { healthKey: "shared", maxConcurrency: 1 },
      { healthKey: "other", maxConcurrency: 1 },
    ]);
    expect(admission.acquire(0)).toBe(1);

    expect(admission.canAcquire(1)).toBe(false);
    expect(admission.canAcquireAfterRelease(1, 0)).toBe(true);
    expect(admission.canAcquireAfterRelease(2, 0)).toBe(true);
  });

  it("additively increases and halves an adaptive limit on rate limits", () => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          increaseAfterSuccesses: 2,
          initial: 2,
          max: 4,
          min: 1,
        },
      },
    ]);
    admission.observe(0, true);
    admission.observe(0, true);
    expect(admission.limit(0)).toBe(3);
    expect(admission.snapshot(0)).toMatchObject({
      adaptive: true,
      inFlight: 0,
      limit: 3,
      max: 4,
      min: 1,
      successes: 0,
      waiting: 0,
    });

    admission.observe(0, false, {
      retryable: true,
      scope: "credential",
      statusCode: 429,
    });
    expect(admission.limit(0)).toBe(1);
  });

  it.each([
    408, 425, 500, 503,
  ])("halves an adaptive limit on retryable congestion status %i", (statusCode) => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          initial: 8,
          max: 8,
          min: 1,
        },
      },
    ]);

    admission.observe(0, false, {
      retryable: true,
      scope: "transient",
      statusCode,
    });

    expect(admission.limit(0)).toBe(4);
  });

  it("does not halve adaptive capacity for non-congestion routing failures", () => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          initial: 8,
          max: 8,
          min: 1,
        },
      },
    ]);

    admission.observe(0, false, {
      retryable: true,
      scope: "routing-unit",
      statusCode: 404,
    });

    expect(admission.limit(0)).toBe(8);
  });

  it("ignores a stale success completed after a newer congestion failure", () => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          increaseAfterSuccesses: 1,
          initial: 8,
          max: 8,
          min: 1,
        },
      },
    ]);

    admission.observe(
      0,
      false,
      { retryable: true, scope: "transient", statusCode: 503 },
      20
    );
    admission.observe(0, true, undefined, 10);

    expect(admission.limit(0)).toBe(4);
    expect(admission.snapshot(0).successes).toBe(0);
  });

  it("ignores a stale congestion failure completed after a newer success", () => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          increaseAfterSuccesses: 1,
          initial: 4,
          max: 8,
          min: 1,
        },
      },
    ]);

    admission.observe(0, true, undefined, 20);
    admission.observe(
      0,
      false,
      { retryable: true, scope: "transient", statusCode: 503 },
      10
    );

    expect(admission.limit(0)).toBe(5);
  });

  it("uses ordering tokens when concurrent outcomes share one start timestamp", () => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          increaseAfterSuccesses: 1,
          initial: 8,
          max: 8,
          min: 1,
        },
      },
    ]);
    const older = "v1:0000000001000:source0000000000:000001";
    const newer = "v1:0000000001000:source0000000000:000002";

    admission.observe(
      0,
      false,
      { retryable: true, scope: "transient", statusCode: 503 },
      10,
      newer
    );
    admission.observe(0, true, undefined, 10, older);

    expect(admission.limit(0)).toBe(4);
    expect(admission.snapshot(0).successes).toBe(0);

    const rollover = new AdmissionController([
      {
        adaptiveConcurrency: {
          increaseAfterSuccesses: 1,
          initial: 8,
          max: 8,
          min: 1,
        },
      },
    ]);
    rollover.observe(
      0,
      false,
      { retryable: true, scope: "transient", statusCode: 503 },
      10,
      "v1:10000000000000:source0000000000:000000"
    );
    rollover.observe(
      0,
      true,
      undefined,
      10,
      "v1:9999999999999:source0000000000:999999"
    );
    expect(rollover.limit(0)).toBe(4);
  });

  it("does not reset AIMD progress for request-scoped failures", () => {
    const admission = new AdmissionController([
      {
        adaptiveConcurrency: {
          increaseAfterSuccesses: 2,
          initial: 1,
          max: 2,
          min: 1,
        },
      },
    ]);
    admission.observe(0, true);
    admission.observe(0, false, { retryable: false, scope: "request" });
    admission.observe(0, true);

    expect(admission.limit(0)).toBe(2);
  });

  it("rebuilds malformed shared adaptive state", () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [
        {
          adaptiveConcurrency: {
            increaseAfterSuccesses: 2,
            initial: 1,
            max: 4,
            min: 1,
          },
        },
      ],
      undefined,
      "default",
      registry
    );
    expect(admission.limit(0)).toBe(1);
    const state = registry.adaptiveStates.get("default:unit:0");
    expect(state).toBeDefined();
    if (state !== undefined) {
      state.limit = Number.NaN;
      state.successes = -1;
    }

    expect(admission.limit(0)).toBe(1);
    expect(admission.snapshot(0)).toMatchObject({
      limit: 1,
      successes: 0,
    });
  });

  it("snapshots hostile adaptive state once and rebuilds unreadable state", () => {
    const registry = new AdmissionRegistry();
    const admission = new AdmissionController(
      [{ adaptiveConcurrency: { initial: 2, max: 4, min: 1 } }],
      undefined,
      "default",
      registry
    );
    const reads = new Map<string, number>();
    const state = new Proxy(
      {
        increaseAfterSuccesses: 3,
        limit: 2,
        max: 4,
        min: 1,
        successes: 1,
      },
      {
        get(target, key, receiver) {
          if (typeof key === "string") {
            reads.set(key, (reads.get(key) ?? 0) + 1);
          }
          return Reflect.get(target, key, receiver);
        },
      }
    );
    registry.adaptiveStates.set("default:unit:0", state);

    expect(admission.snapshot(0)).toMatchObject({ limit: 2, successes: 1 });
    expect([...reads.values()]).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(registry.adaptiveStates.get("default:unit:0")).not.toBe(state);

    registry.adaptiveStates.set(
      "default:unit:0",
      new Proxy(state, {
        get() {
          throw new Error("adaptive state unavailable");
        },
      })
    );
    expect(() => admission.snapshot(0)).not.toThrow();
    expect(admission.snapshot(0)).toMatchObject({ limit: 2, successes: 0 });
  });

  it("orders by current load and rotates round-robin candidates", () => {
    const admission = new AdmissionController([
      { maxConcurrency: 2 },
      { maxConcurrency: 2 },
      { maxConcurrency: 2 },
    ]);
    admission.acquire(0);
    const leastLoaded = [{ fullIndex: 0 }, { fullIndex: 1 }];
    admission.reorder(leastLoaded, "least-inflight");
    expect(leastLoaded.map(({ fullIndex }) => fullIndex)).toEqual([1, 0]);

    const first = [{ fullIndex: 0 }, { fullIndex: 1 }, { fullIndex: 2 }];
    const second = [{ fullIndex: 0 }, { fullIndex: 1 }, { fullIndex: 2 }];
    admission.reorder(first, "round-robin");
    admission.reorder(second, "round-robin");
    expect(first.map(({ fullIndex }) => fullIndex)).toEqual([0, 1, 2]);
    expect(second.map(({ fullIndex }) => fullIndex)).toEqual([1, 2, 0]);
  });

  it("keeps independent round-robin cursors for filtered candidate pools", () => {
    const admission = new AdmissionController([{}, {}, {}]);
    const firstPool = [{ fullIndex: 0 }, { fullIndex: 2 }];
    const otherPool = [{ fullIndex: 1 }, { fullIndex: 2 }];
    const firstPoolAgain = [{ fullIndex: 0 }, { fullIndex: 2 }];

    admission.reorder(firstPool, "round-robin");
    admission.reorder(otherPool, "round-robin");
    admission.reorder(firstPoolAgain, "round-robin");

    expect(firstPool.map(({ fullIndex }) => fullIndex)).toEqual([0, 2]);
    expect(otherPool.map(({ fullIndex }) => fullIndex)).toEqual([1, 2]);
    expect(firstPoolAgain.map(({ fullIndex }) => fullIndex)).toEqual([2, 0]);
  });

  it("bounds retained round-robin pools and resets an evicted cursor", () => {
    const admission = new AdmissionController(
      Array.from({ length: 12 }, () => ({}))
    );
    const firstPool = [{ fullIndex: 0 }, { fullIndex: 1 }];
    admission.reorder(firstPool, "round-robin");

    let generated = 0;
    for (let mask = 1; generated < 1024; mask++) {
      const pool = Array.from({ length: 12 }, (_, index) => index)
        .filter((index) => Math.floor(mask / 2 ** index) % 2 !== 0)
        .map((fullIndex) => ({ fullIndex }));
      if (
        pool.length < 2 ||
        (pool.length === 2 &&
          pool[0]?.fullIndex === 0 &&
          pool[1]?.fullIndex === 1)
      ) {
        continue;
      }
      admission.reorder(pool, "round-robin");
      generated += 1;
    }

    const firstPoolAfterEviction = [{ fullIndex: 0 }, { fullIndex: 1 }];
    admission.reorder(firstPoolAfterEviction, "round-robin");
    expect(firstPoolAfterEviction.map(({ fullIndex }) => fullIndex)).toEqual([
      0, 1,
    ]);
  });

  it("uses exact bounded round-robin identities for maximum-size pools", () => {
    const admission = new AdmissionController(
      Array.from({ length: 10_000 }, () => ({}))
    );
    const first = Array.from({ length: 10_000 }, (_, fullIndex) => ({
      fullIndex,
    }));
    const second = Array.from({ length: 10_000 }, (_, fullIndex) => ({
      fullIndex,
    }));

    admission.reorder(first, "round-robin");
    admission.reorder(second, "round-robin");

    expect(first[0]?.fullIndex).toBe(0);
    expect(second[0]?.fullIndex).toBe(1);
    const cursors = (
      admission as unknown as {
        roundRobinCursors: Map<string, number>;
      }
    ).roundRobinCursors;
    expect(cursors.size).toBe(1);
    const [identity] = cursors.keys();
    expect(identity?.startsWith("0,1,2,3,4,5")).toBe(true);
    expect(identity?.endsWith("9997,9998,9999")).toBe(true);
    expect(identity?.length).toBeLessThan(50_000);
  });

  it("bounds aggregate exact round-robin identity retention", () => {
    const admission = new AdmissionController(
      Array.from({ length: 10_000 }, () => ({}))
    );

    for (let omitted = 0; omitted < 24; omitted += 1) {
      const pool = Array.from({ length: 10_000 }, (_, fullIndex) => ({
        fullIndex,
      })).filter(({ fullIndex }) => fullIndex !== omitted);
      admission.reorder(pool, "round-robin");
    }

    const state = admission as unknown as {
      roundRobinCursors: Map<string, number>;
      roundRobinPoolKeyChars: number;
    };
    expect(state.roundRobinPoolKeyChars).toBeLessThanOrEqual(1_048_576);
    expect(state.roundRobinCursors.size).toBeLessThan(24);
  });
});
