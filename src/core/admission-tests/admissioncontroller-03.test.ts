import { describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../admission";
import { AdmissionRegistry } from "../admission-utils";

describe("AdmissionController", () => {
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
});
