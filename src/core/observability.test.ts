import { describe, expect, it } from "vitest";
import {
  runAttemptObservabilityHook,
  runErrorObservabilityHook,
  runObservabilityHook,
} from "./observability";

describe("runObservabilityHook", () => {
  it("isolates synchronous hook failures", () => {
    expect(() =>
      runObservabilityHook(() => {
        throw new Error("sync hook failed");
      })
    ).not.toThrow();
  });

  it("consumes asynchronous hook rejections", async () => {
    runObservabilityHook(() => Promise.reject(new Error("async hook failed")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(true).toBe(true);
  });

  it("does not inspect arbitrary thenable-like hook results", () => {
    let reads = 0;
    const result = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        reads += 1;
        throw new Error("then getter must not run");
      },
    });

    expect(() => runObservabilityHook(() => result)).not.toThrow();
    expect(reads).toBe(0);
  });
});

describe("runAttemptObservabilityHook", () => {
  it("consumes rejected Promise mutations in known event and failure fields", async () => {
    const payload: Record<string, unknown> = {
      durationMs: 1,
      failure: { retryable: true, scope: "transient" },
      outcome: "failure",
    };
    runAttemptObservabilityHook(payload, (event) => {
      event.durationMs = Promise.reject(new Error("async duration"));
      event.outcome = Promise.reject(new Error("async outcome"));
      const failure = event.failure as Record<string, unknown>;
      failure.cooldownMs = Promise.reject(new Error("async cooldown"));
      failure.retryAfterMs = Promise.reject(new Error("async retry-after"));
      failure.retryable = Promise.reject(new Error("async retryable"));
      failure.scope = Promise.reject(new Error("async scope"));
      failure.statusCode = Promise.reject(new Error("async status"));
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(true).toBe(true);
  });

  it("does not invoke accessors added to known payload fields", () => {
    let reads = 0;
    const payload: Record<string, unknown> = { outcome: "success" };
    runAttemptObservabilityHook(payload, (event) => {
      Object.defineProperty(event, "durationMs", {
        configurable: true,
        get() {
          reads += 1;
          throw new Error("duration accessor must not run");
        },
      });
    });

    expect(reads).toBe(0);
  });
});

describe("runErrorObservabilityHook", () => {
  it("consumes rejected Promise mutations in known error event fields", async () => {
    const payload: Record<string, unknown> = {
      error: new Error("provider failed"),
      phase: "generate",
      willRetry: true,
    };
    runErrorObservabilityHook(payload, (event) => {
      event.entry = Promise.reject(new Error("async entry"));
      event.error = Promise.reject(new Error("async error"));
      event.index = Promise.reject(new Error("async index"));
      event.logicalId = Promise.reject(new Error("async logical id"));
      event.phase = Promise.reject(new Error("async phase"));
      event.willRetry = Promise.reject(new Error("async retry flag"));
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(true).toBe(true);
  });
});
