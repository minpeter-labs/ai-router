import { describe, expect, it, vi } from "vitest";
import {
  abortControllerSafely,
  durationMs,
  jitteredBackoff,
  monotonicNow,
  RouterCancellationError,
  RouterTimeoutError,
  RouterTimerError,
  withTimeout,
} from "./timeout";

const COOLDOWN_RE = /cooldown/;
const INVALID_DURATION_RE = /invalid duration/;
const MAX_DURATION_RE = /at most 24h/;

describe("monotonicNow", () => {
  it("falls back safely when platform clocks throw or return invalid values", () => {
    const performanceNow = vi.spyOn(performance, "now");
    const dateNow = vi.spyOn(Date, "now");
    try {
      performanceNow.mockReturnValue(Number.NaN);
      dateNow.mockReturnValue(1234);
      expect(monotonicNow()).toBe(1234);

      performanceNow.mockReturnValue(-1);
      dateNow.mockReturnValue(-1);
      expect(monotonicNow()).toBe(0);

      performanceNow.mockImplementation(() => {
        throw new Error("performance clock unavailable");
      });
      dateNow.mockImplementation(() => {
        throw new Error("wall clock unavailable");
      });
      expect(monotonicNow()).toBe(0);

      performanceNow.mockReturnValue(Number.MAX_VALUE);
      dateNow.mockReturnValue(Number.MAX_VALUE);
      expect(monotonicNow()).toBe(0);
    } finally {
      performanceNow.mockRestore();
      dateNow.mockRestore();
    }
  });

  it("consumes Promise-valued platform clock samples", async () => {
    const performanceNow = vi
      .spyOn(performance, "now")
      .mockImplementation(
        () => Promise.reject(new Error("async performance clock")) as never
      );
    const dateNow = vi
      .spyOn(Date, "now")
      .mockImplementation(
        () => Promise.reject(new Error("async wall clock")) as never
      );
    try {
      expect(monotonicNow()).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      dateNow.mockRestore();
      performanceNow.mockRestore();
    }
  });
});

describe("durationMs", () => {
  it("rounds positive sub-millisecond durations up to one millisecond", () => {
    expect(durationMs("0.1ms")).toBe(1);
    expect(durationMs(0.1)).toBe(1);
  });

  it("uses generic duration diagnostics for malformed timeout strings", () => {
    expect(() => durationMs("soon" as never)).toThrow(INVALID_DURATION_RE);
    expect(() => durationMs("soon" as never)).not.toThrow(COOLDOWN_RE);
  });

  it("accepts at most 24 hours", () => {
    expect(durationMs("24h")).toBe(86_400_000);
    expect(() => durationMs("24.0001h")).toThrow(MAX_DURATION_RE);
  });
});

describe("withTimeout", () => {
  it("does not assimilate arbitrary provider thenable extensions", async () => {
    let thenReads = 0;
    const operation = () =>
      Object.defineProperty({}, ["th", "en"].join(""), {
        get() {
          thenReads += 1;
          throw new Error("then extension must not run");
        },
      }) as never;

    await expect(withTimeout(operation, undefined, undefined)).rejects.toThrow(
      "provider operation must return a genuine Promise"
    );
    await expect(withTimeout(operation, 1000, undefined)).rejects.toThrow(
      "provider operation must return a genuine Promise"
    );
    expect(thenReads).toBe(0);
  });

  it("does not require AbortController without timeout or caller cancellation", async () => {
    const OriginalAbortController = globalThis.AbortController;
    vi.stubGlobal(
      "AbortController",
      class BrokenAbortController {
        constructor() {
          throw new Error("AbortController unavailable");
        }
      }
    );
    try {
      await expect(
        withTimeout(async () => "ok", undefined, undefined)
      ).resolves.toBe("ok");
    } finally {
      vi.stubGlobal("AbortController", OriginalAbortController);
    }
  });

  it("fails before operation start when required AbortController creation fails", async () => {
    const OriginalAbortController = globalThis.AbortController;
    const operation = vi.fn(async () => "must not run");
    vi.stubGlobal(
      "AbortController",
      class BrokenAbortController {
        constructor() {
          throw new Error("AbortController unavailable");
        }
      }
    );
    const result = withTimeout(operation, 1000, undefined);
    vi.stubGlobal("AbortController", OriginalAbortController);

    await expect(result).rejects.toBeInstanceOf(RouterCancellationError);
    expect(operation).not.toHaveBeenCalled();
  });

  it("settles timeout even when AbortController.abort throws", async () => {
    const OriginalAbortController = globalThis.AbortController;
    vi.stubGlobal(
      "AbortController",
      class BrokenAbortController {
        readonly signal = new OriginalAbortController().signal;
        abort() {
          throw new Error("abort unavailable");
        }
      }
    );
    try {
      await expect(
        withTimeout(() => new Promise<never>(() => undefined), 1, undefined)
      ).rejects.toBeInstanceOf(RouterTimeoutError);
    } finally {
      vi.stubGlobal("AbortController", OriginalAbortController);
    }
  });

  it("consumes async abort method slots and results", async () => {
    expect(() =>
      abortControllerSafely(
        {
          abort: Promise.reject(new Error("async abort method")),
        } as never,
        "stop"
      )
    ).not.toThrow();
    expect(() =>
      abortControllerSafely(
        {
          abort: () => Promise.reject(new Error("async abort result")),
        } as never,
        "stop"
      )
    ).not.toThrow();

    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    abortControllerSafely({ abort: thenable } as never, "stop");
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes Promise-valued abort state and reasons", async () => {
    const unreadableState = {
      addEventListener() {
        // Not aborted after the invalid async state is ignored.
      },
      get aborted() {
        return Promise.reject(new Error("async aborted state"));
      },
      removeEventListener() {
        // Cleanup is synchronous.
      },
    } as unknown as AbortSignal;
    await expect(
      withTimeout(async () => "ok", undefined, unreadableState)
    ).resolves.toBe("ok");

    const asyncReason = {
      aborted: true,
      addEventListener() {
        // Already aborted.
      },
      reason: Promise.reject(new Error("async abort reason")),
      removeEventListener() {
        // Already aborted.
      },
    } as unknown as AbortSignal;
    await expect(
      withTimeout(async () => "unused", undefined, asyncReason)
    ).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not start an operation when timer registration fails", async () => {
    const operation = vi.fn(async () => "must not run");
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => {
      throw new Error("timer unavailable");
    });
    const result = withTimeout(operation, 1000, undefined);
    timer.mockRestore();

    await expect(result).rejects.toBeInstanceOf(RouterTimerError);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
  });

  it("exposes stable timeout diagnostics", () => {
    expect(new RouterTimeoutError("attempt_timeout", 250)).toMatchObject({
      code: "attempt_timeout",
      durationMs: 250,
      name: "RouterTimeoutError",
    });
  });

  it("separates the scheduled delay from the configured diagnostic duration", async () => {
    await expect(
      withTimeout(
        () => new Promise<never>(() => undefined),
        1,
        undefined,
        "total_timeout",
        50
      )
    ).rejects.toMatchObject({
      code: "total_timeout",
      durationMs: 50,
    });
  });

  it("rejects promptly on caller abort when the operation ignores its signal", async () => {
    const controller = new AbortController();
    const result = withTimeout(
      () => new Promise<never>(() => undefined),
      undefined,
      controller.signal
    );

    controller.abort(new Error("caller stopped"));

    await expect(result).rejects.toThrow("caller stopped");
  });

  it("does not start a deferred operation after an immediate caller abort", async () => {
    const controller = new AbortController();
    let called = false;
    const reason = new Error("stopped before provider start");
    const result = withTimeout(
      () => {
        called = true;
        return new Promise<never>(() => undefined);
      },
      undefined,
      controller.signal
    );

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(called).toBe(false);
  });

  it("does not miss an abort during caller-listener registration", async () => {
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
        // The synthetic signal does not retain listeners.
      },
    } as unknown as AbortSignal;
    const operation = vi.fn(() => new Promise<never>(() => undefined));

    await expect(withTimeout(operation, undefined, signal)).rejects.toBe(
      reason
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("preserves a delivered caller abort when registration then throws", async () => {
    const reason = new Error("caller aborted during failed registration");
    const registrationFailure = new Error("listener registration failed");
    let aborted = false;
    const signal = {
      addEventListener(_name: string, listener: () => void) {
        aborted = true;
        listener();
        throw registrationFailure;
      },
      get aborted() {
        return aborted;
      },
      reason,
      removeEventListener() {
        // Registration rollback has no retained listener.
      },
    } as unknown as AbortSignal;
    const operation = vi.fn(() => new Promise<never>(() => undefined));

    await expect(withTimeout(operation, undefined, signal)).rejects.toBe(
      reason
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("captures a repeatedly delivered caller abort reason once", async () => {
    let reasonReads = 0;
    const reason = new Error("caller stopped repeatedly");
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
        // The synthetic signal does not retain listeners.
      },
    } as unknown as AbortSignal;

    await expect(
      withTimeout(() => new Promise<never>(() => undefined), undefined, signal)
    ).rejects.toBe(reason);
    expect(reasonReads).toBe(1);
  });

  it("normalizes an undefined abort reason once without re-reading it", async () => {
    let aborted = false;
    let reasonReads = 0;
    const signal = {
      addEventListener(_name: string, listener: () => void) {
        aborted = true;
        listener();
      },
      get aborted() {
        return aborted;
      },
      get reason() {
        reasonReads += 1;
        return reasonReads === 1 ? undefined : new Error("mutated reason");
      },
      removeEventListener() {
        // The synthetic signal does not retain listeners.
      },
    } as unknown as AbortSignal;

    await expect(
      withTimeout(() => new Promise<never>(() => undefined), undefined, signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(reasonReads).toBe(1);
  });

  it("preserves a caller's non-Error abort reason", async () => {
    const controller = new AbortController();
    const result = withTimeout(
      () => new Promise<never>(() => undefined),
      undefined,
      controller.signal
    );

    controller.abort("caller stopped");

    await expect(result).rejects.toBe("caller stopped");
  });

  it("forwards caller abort and reason without AbortSignal.any", async () => {
    const any = vi.spyOn(AbortSignal, "any").mockImplementation(() => {
      throw new Error("AbortSignal.any is unavailable");
    });
    try {
      const controller = new AbortController();
      let providerSignal: AbortSignal | undefined;
      const result = withTimeout(
        (signal) => {
          providerSignal = signal;
          return new Promise<never>(() => undefined);
        },
        undefined,
        controller.signal
      );
      const reason = new Error("forwarded abort");

      await Promise.resolve();

      controller.abort(reason);

      await expect(result).rejects.toBe(reason);
      expect(providerSignal).toMatchObject({ aborted: true, reason });
      expect(any).not.toHaveBeenCalled();
    } finally {
      any.mockRestore();
    }
  });

  it("clears its timer and caller listener after success", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    try {
      await expect(
        withTimeout(async () => "ok", 60_000, controller.signal)
      ).resolves.toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      remove.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not let listener cleanup replace a successful result", async () => {
    const signal = {
      aborted: false,
      addEventListener() {
        // The operation completes before cancellation.
      },
      removeEventListener() {
        throw new Error("listener cleanup unavailable");
      },
    } as unknown as AbortSignal;

    await expect(withTimeout(async () => "ok", 1000, signal)).resolves.toBe(
      "ok"
    );
  });

  it("does not let timer cleanup replace a successful result", async () => {
    const clear = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => {
        throw new Error("timer cleanup unavailable");
      });
    try {
      await expect(
        withTimeout(async () => "ok", 1000, undefined)
      ).resolves.toBe("ok");
    } finally {
      clear.mockRestore();
    }
  });

  it("consumes rejected Promise timer cleanup results", async () => {
    const clear = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(
        () => Promise.reject(new Error("async timer cleanup")) as never
      );
    try {
      await expect(
        withTimeout(async () => "ok", 1000, undefined)
      ).resolves.toBe("ok");
      await Promise.resolve();
    } finally {
      clear.mockRestore();
    }
  });

  it("does not start an operation when listener registration throws", async () => {
    const failure = new Error("listener registration unavailable");
    const signal = {
      aborted: false,
      addEventListener() {
        throw failure;
      },
      removeEventListener() {
        // Registration failed before a listener was retained.
      },
    } as unknown as AbortSignal;
    const operation = vi.fn(() => new Promise<never>(() => undefined));

    await expect(withTimeout(operation, undefined, signal)).rejects.toBe(
      failure
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("runs best-effort cleanup when an operation resolves after timeout", async () => {
    let resolveOperation: ((value: string) => void) | undefined;
    let cleaned: string | undefined;
    const result = withTimeout(
      () =>
        new Promise<string>((resolve) => {
          resolveOperation = resolve;
        }),
      1,
      undefined,
      "attempt_timeout",
      1,
      (value) => {
        cleaned = value;
        throw new Error("cleanup failure is isolated");
      }
    );

    await expect(result).rejects.toMatchObject({ code: "attempt_timeout" });
    resolveOperation?.("late value");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(cleaned).toBe("late value");
  });

  it("consumes native Promise late-cleanup results without probing thenables", async () => {
    const runLate = async (cleanup: (value: string) => unknown) => {
      let resolveOperation: ((value: string) => void) | undefined;
      const result = withTimeout(
        () =>
          new Promise<string>((resolve) => {
            resolveOperation = resolve;
          }),
        1,
        undefined,
        "attempt_timeout",
        1,
        cleanup
      );
      await expect(result).rejects.toMatchObject({ code: "attempt_timeout" });
      resolveOperation?.("late value");
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await runLate(() =>
      Promise.reject(new Error("async late cleanup rejected"))
    );
    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("late cleanup then extension must not run");
      },
    });
    await runLate(() => thenable);
    expect(thenReads).toBe(0);
  });
});

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
