import { describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../admission";
import { AdmissionRegistry } from "../admission-utils";

describe("AdmissionController", () => {
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
});
