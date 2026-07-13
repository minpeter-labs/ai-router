import { describe, expect, it, vi } from "vitest";
import { jitteredBackoff } from "../timeout";

describe("jitteredBackoff", () => {
  it("reports timer registration failure with a stable request error", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => {
      throw new Error("timer unavailable");
    });
    const result = jitteredBackoff(1000);
    timer.mockRestore();

    await expect(result).rejects.toMatchObject({ code: "timer_unavailable" });
  });

  it("consumes Promise-valued timer handles as registration failures", async () => {
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(
        () => Promise.reject(new Error("async timer handle")) as never
      );
    const result = jitteredBackoff(1000);
    timer.mockRestore();

    await expect(result).rejects.toMatchObject({ code: "timer_unavailable" });
    await Promise.resolve();
  });

  it("fails open to zero delay when the random source throws", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("random unavailable");
    });
    try {
      const pending = jitteredBackoff(1000);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBeUndefined();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("consumes async random results without reading thenables", async () => {
    vi.useFakeTimers();
    const rejected = vi
      .spyOn(Math, "random")
      .mockImplementation(
        () => Promise.reject(new Error("async random unsupported")) as never
      );
    try {
      const pending = jitteredBackoff(1000);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBeUndefined();
      await Promise.resolve();
    } finally {
      rejected.mockRestore();
    }

    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    const extension = vi
      .spyOn(Math, "random")
      .mockImplementation(() => thenable as never);
    try {
      const pending = jitteredBackoff(1000);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBeUndefined();
      expect(thenReads).toBe(0);
    } finally {
      extension.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not register an abort listener after a synchronous timer fires", async () => {
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
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void
    ) => {
      callback();
      return 1 as never;
    }) as unknown as typeof setTimeout);
    try {
      await expect(jitteredBackoff(1000, signal)).resolves.toBeUndefined();
      expect(subscriptions).toBe(0);
    } finally {
      timer.mockRestore();
    }
  });

  it("rejects immediately when its signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before backoff"));

    await expect(jitteredBackoff(60_000, controller.signal)).rejects.toThrow(
      "cancelled before backoff"
    );
  });

  it("clears its pending timer when aborted", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = jitteredBackoff(60_000, controller.signal);
      controller.abort(new Error("cancelled"));

      await expect(pending).rejects.toThrow("cancelled");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not miss an abort during backoff-listener registration", async () => {
    const reason = new Error("backoff aborted while subscribing");
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
        // The synthetic signal does not retain listeners.
      },
    } as unknown as AbortSignal;

    await expect(jitteredBackoff(1000, signal)).rejects.toBe(reason);
  });

  it("captures a repeatedly delivered backoff abort reason once", async () => {
    let reasonReads = 0;
    let removals = 0;
    const reason = new Error("backoff stopped repeatedly");
    const signal = {
      aborted: false,
      addEventListener(_name: string, listener: () => void) {
        listener();
        listener();
      },
      get reason() {
        reasonReads += 1;
        return reason;
      },
      removeEventListener() {
        removals += 1;
      },
    } as unknown as AbortSignal;

    await expect(jitteredBackoff(1000, signal)).rejects.toBe(reason);
    expect(reasonReads).toBe(1);
    expect(removals).toBe(1);
  });
});
