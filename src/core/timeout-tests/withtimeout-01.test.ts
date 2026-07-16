import { describe, expect, it, vi } from "vitest";
import {
  abortControllerSafely,
  RouterCancellationError,
  RouterTimeoutError,
  RouterTimerError,
} from "../timeout";
import { withTimeout } from "../timeout-operation";
import { promiseLike } from "./test-kit";

describe("withTimeout", () => {
  it("assimilates provider PromiseLike operation results", async () => {
    const result = promiseLike("ok");
    const then = vi.spyOn(result, "then");
    const operation = () => result;

    await expect(withTimeout(operation, undefined, undefined)).resolves.toBe(
      "ok"
    );
    await expect(withTimeout(operation, 1000, undefined)).resolves.toBe("ok");
    expect(then).toHaveBeenCalledTimes(2);
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
});
