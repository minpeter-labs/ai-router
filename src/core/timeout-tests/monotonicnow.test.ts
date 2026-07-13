import { describe, expect, it, vi } from "vitest";
import { monotonicNow } from "../timeout";

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
