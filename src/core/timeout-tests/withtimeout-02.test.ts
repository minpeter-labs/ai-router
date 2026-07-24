import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "../timeout-operation";

describe("withTimeout", () => {
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
});
