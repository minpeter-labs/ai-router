import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "../timeout-operation";

describe("withTimeout", () => {
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
