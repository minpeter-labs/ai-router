import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import {
  type FallbackStreamArgs,
  type ResolvedEntry,
  wrapStreamResult,
} from "../stream";
import {
  callOptions,
  drive,
  errorPartModel,
  resolved,
  textModel,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("rejects candidate array accessors without executing them", () => {
    let reads = 0;
    let upstreamCancelled = 0;
    const candidate = resolved(textModel(["must not run"]), 0);
    const candidates = [candidate];
    Object.defineProperty(candidates, 0, {
      configurable: true,
      get() {
        reads += 1;
        throw new Error("candidate accessor must not run");
      },
    });
    const args: FallbackStreamArgs = {
      candidates,
      firstResult: {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            upstreamCancelled += 1;
          },
        }),
      },
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };

    expect(() => wrapStreamResult(args)).toThrow(
      expect.objectContaining({ code: "stream_unavailable" })
    );
    expect(reads).toBe(0);
    expect(upstreamCancelled).toBe(1);
  });

  it("rejects ResolvedEntry field accessors without executing them", () => {
    let reads = 0;
    let upstreamCancelled = 0;
    const model = textModel(["must not run"]);
    const candidate = Object.defineProperty(
      { entry: model, model },
      "fullIndex",
      {
        get() {
          reads += 1;
          return 0;
        },
      }
    ) as unknown as ResolvedEntry;
    const args: FallbackStreamArgs = {
      candidates: [candidate],
      firstResult: {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            upstreamCancelled += 1;
          },
        }),
      },
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };

    expect(() => wrapStreamResult(args)).toThrow(
      expect.objectContaining({ code: "stream_unavailable" })
    );
    expect(reads).toBe(0);
    expect(upstreamCancelled).toBe(1);
  });

  it("consumes an async lazy candidate model and continues fallback", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["survived"]);
    const asyncCandidate = {
      entry: survivor,
      fullIndex: 1,
      get model() {
        return Promise.reject(new Error("async model unsupported"));
      },
    } as unknown as ResolvedEntry;
    const candidates = [
      resolved(primary, 0),
      asyncCandidate,
      resolved(survivor, 2),
    ];
    const firstResult = await primary.doStream(callOptions);
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({
      text: "survived",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("preserves stream setup errors across hostile cleanup accessors", () => {
    const OriginalReadableStream = globalThis.ReadableStream;
    let upstreamCancelled = 0;
    let probeReleased = 0;
    const model = textModel(["must not run"]);
    const args: FallbackStreamArgs = {
      candidates: [resolved(model, 0)],
      firstResult: {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            upstreamCancelled += 1;
          },
        }),
      },
      logicalId: "chat",
      options: callOptions,
      releaseProbeCandidate: () => {
        probeReleased += 1;
      },
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };
    Object.defineProperty(args, "releaseCandidate", {
      get() {
        throw new Error("capacity cleanup accessor failed");
      },
    });
    vi.stubGlobal(
      "ReadableStream",
      class {
        constructor() {
          throw new Error("ReadableStream unavailable");
        }
      }
    );
    try {
      expect(() => wrapStreamResult(args)).toThrow(
        expect.objectContaining({
          cause: expect.objectContaining({
            message: "ReadableStream unavailable",
          }),
          code: "stream_unavailable",
        })
      );
      expect(upstreamCancelled).toBe(1);
      expect(probeReleased).toBe(1);
    } finally {
      vi.stubGlobal("ReadableStream", OriginalReadableStream);
    }
  });

  it("does not re-read candidate accessors during wrapper construction cleanup", () => {
    const OriginalReadableStream = globalThis.ReadableStream;
    let reads = 0;
    let upstreamCancelled = 0;
    const releases: string[] = [];
    const candidate = resolved(textModel(["must not run"]), 0);
    const candidates = [candidate];
    Object.defineProperty(candidates, 0, {
      configurable: true,
      get() {
        reads += 1;
        throw new Error("candidate accessor must not run");
      },
    });
    const args: FallbackStreamArgs = {
      candidates,
      firstResult: {
        stream: new OriginalReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            upstreamCancelled += 1;
          },
        }),
      },
      logicalId: "chat",
      options: callOptions,
      releaseCandidate: () => releases.push("capacity"),
      releaseProbeCandidate: () => releases.push("probe"),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };
    vi.stubGlobal(
      "ReadableStream",
      class {
        constructor() {
          throw new Error("ReadableStream unavailable");
        }
      }
    );
    try {
      expect(() => wrapStreamResult(args)).toThrow(
        expect.objectContaining({ code: "stream_unavailable" })
      );
      expect(reads).toBe(0);
      expect(upstreamCancelled).toBe(1);
      expect(releases).toEqual(["capacity", "probe"]);
    } finally {
      vi.stubGlobal("ReadableStream", OriginalReadableStream);
    }
  });
});
