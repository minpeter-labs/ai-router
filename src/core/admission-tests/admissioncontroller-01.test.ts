import { describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../admission";
import { AdmissionRegistry } from "../admission-utils";

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
});
