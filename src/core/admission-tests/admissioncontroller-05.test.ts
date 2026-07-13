import { describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../admission";
import { AdmissionRegistry } from "../admission-utils";

describe("AdmissionController", () => {
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
});
