import { describe, expect, it, vi } from "vitest";
import { discardLateStreamResult } from "../stream";

describe("discardLateStreamResult", () => {
  it("isolates hostile access and rejected cancellation", async () => {
    let thenReads = 0;
    const throwingResult = Object.defineProperty({}, "stream", {
      get() {
        throw new Error("stream unavailable");
      },
    });
    const throwingCancel = {
      stream: {
        cancel() {
          throw new Error("cancel unavailable");
        },
      },
    };
    const rejectingCancel = {
      stream: {
        cancel() {
          return Promise.reject(new Error("cancel rejected"));
        },
      },
    };
    const rejectingStream = {
      stream: Promise.reject(new Error("stream rejected")),
    };
    const rejectingCancelSlot = {
      stream: {
        cancel: Promise.reject(new Error("cancel slot rejected")),
      },
    };
    const extensionCancel = {
      stream: {
        cancel() {
          return Object.defineProperty({}, ["th", "en"].join(""), {
            get() {
              thenReads += 1;
              throw new Error("then extension must not run");
            },
          });
        },
      },
    };

    expect(() =>
      discardLateStreamResult(throwingResult as never)
    ).not.toThrow();
    expect(() =>
      discardLateStreamResult(throwingCancel as never)
    ).not.toThrow();
    expect(() =>
      discardLateStreamResult(rejectingCancel as never)
    ).not.toThrow();
    expect(() =>
      discardLateStreamResult(rejectingStream as never)
    ).not.toThrow();
    expect(() =>
      discardLateStreamResult(rejectingCancelSlot as never)
    ).not.toThrow();
    expect(() =>
      discardLateStreamResult(extensionCancel as never)
    ).not.toThrow();
    await Promise.resolve();
    expect(thenReads).toBe(0);
    await Promise.resolve();
  });

  it("consumes rejected metadata siblings on a discarded late result", async () => {
    const result = {
      request: {
        body: {
          prompt: Promise.reject(new Error("late request field rejected")),
        },
      },
      response: {
        headers: {
          "x-late": Promise.reject(new Error("late header rejected")),
        },
      },
      stream: {
        cancel: Promise.reject(new Error("late cancel slot rejected")),
      },
    };

    expect(() => discardLateStreamResult(result as never)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("cancels a late stream independently of hostile metadata", () => {
    const cancel = vi.fn();
    const result = {
      get request(): never {
        throw new Error("late request unavailable");
      },
      get response(): never {
        throw new Error("late response unavailable");
      },
      stream: { cancel },
    };

    expect(() => discardLateStreamResult(result as never)).not.toThrow();
    expect(cancel).toHaveBeenCalledWith("late stream result discarded");
  });

  it("starts late stream cancellation before bounded metadata cleanup", () => {
    const order: string[] = [];
    const result = {
      get request() {
        order.push("request");
        return { body: {} };
      },
      get response() {
        order.push("response");
        return { headers: {} };
      },
      stream: {
        cancel() {
          order.push("cancel");
        },
      },
    };

    discardLateStreamResult(result as never);

    expect(order).toEqual(["cancel", "request", "response"]);
  });
});
