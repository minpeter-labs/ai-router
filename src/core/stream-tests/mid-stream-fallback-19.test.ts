import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { defaultShouldRetryThisError } from "../retry";
import {
  createFallbackStream,
  type FallbackStreamArgs,
  type ResolvedEntry,
  wrapStreamResult,
} from "../stream";
import {
  callOptions,
  drive,
  errorPartModel,
  resolved,
  runFallback,
  textModel,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("cleans initial ownership and consumes Promise siblings when hook capture fails", async () => {
    let upstreamCancelled = 0;
    const releases: string[] = [];
    const model = textModel(["must not run"]);
    const candidate = resolved(model, 0);
    const firstResult = {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        cancel() {
          upstreamCancelled += 1;
        },
      }),
    };
    const args: FallbackStreamArgs = {
      candidates: [candidate],
      firstResult,
      logicalId: "chat",
      onError: Promise.reject(new Error("async hook sibling")) as never,
      options: callOptions,
      releaseCandidate: () => releases.push("capacity"),
      releaseProbeCandidate: () => releases.push("probe"),
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };
    Object.defineProperty(args, "acquireCandidate", {
      get() {
        throw new Error("acquire hook unavailable");
      },
    });

    expect(() => wrapStreamResult(args)).toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ message: "acquire hook unavailable" }),
        code: "stream_unavailable",
      })
    );
    expect(upstreamCancelled).toBe(1);
    expect(releases).toEqual(["capacity", "probe"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("isolates capacity cleanup mutation from canonical probe cleanup", async () => {
    const model = textModel(["ok"]);
    const candidate = resolved(model, 1);
    const lease = { key: "lease", probingUntil: 123 };
    candidate.probeLease = lease;
    const releasedCapacity: number[] = [];
    const releasedProbe: Array<{ fullIndex: number; lease: unknown }> = [];
    let canonicalProbeCandidate: ResolvedEntry | undefined;
    const firstResult = await model.doStream(callOptions);

    const wrapped = wrapStreamResult({
      candidates: [candidate],
      firstResult,
      logicalId: "chat",
      options: callOptions,
      releaseCandidate: (entry) => {
        releasedCapacity.push(entry.fullIndex);
        entry.fullIndex = 999;
        entry.probeLease = undefined;
      },
      releaseProbeCandidate: (entry) => {
        canonicalProbeCandidate = entry;
        releasedProbe.push({
          fullIndex: entry.fullIndex,
          lease: entry.probeLease,
        });
        entry.probeLease = undefined;
      },
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(releasedCapacity).toEqual([1]);
    expect(releasedProbe).toEqual([{ fullIndex: 1, lease }]);
    expect(candidate.fullIndex).toBe(1);
    expect(candidate.probeLease).toBe(lease);
    expect(canonicalProbeCandidate?.probeLease).toBeUndefined();
  });

  it("consumes rejected Promise mutations on discarded cleanup snapshots", async () => {
    const mutateWithRejectedPromises = (candidate: ResolvedEntry) => {
      candidate.entry = Promise.reject(new Error("async entry")) as never;
      candidate.fullIndex = Promise.reject(
        new Error("async full index")
      ) as never;
      Object.defineProperty(candidate, "model", {
        configurable: true,
        enumerable: true,
        value: Promise.reject(new Error("async model")),
      });
      candidate.probeLease = {
        key: Promise.reject(new Error("async probe key")),
        probingUntil: Promise.reject(new Error("async probe deadline")),
      } as never;
    };
    const out = await runFallback([textModel(["ok"])], {
      releaseCandidate: mutateWithRejectedPromises,
      releaseProbeCandidate: mutateWithRejectedPromises,
    });

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected identity mutations on a discarded preparation snapshot", async () => {
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["must not run"]),
      ],
      {
        acquireCandidate: () => 1,
        prepareCandidate: (candidate) => {
          candidate.entry = Promise.reject(
            new Error("async prepared entry")
          ) as never;
          candidate.fullIndex = Promise.reject(
            new Error("async prepared index")
          ) as never;
          Object.defineProperty(candidate, "model", {
            configurable: true,
            enumerable: true,
            value: Promise.reject(new Error("async prepared model")),
          });
          return false;
        },
      }
    );

    expect(out.error).toMatchObject({ message: "primary failed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected mutations on discarded read-only hook snapshots", async () => {
    const mutate = (candidate: ResolvedEntry, label: string) => {
      candidate.entry = Promise.reject(new Error(`${label} entry`)) as never;
      candidate.fullIndex = Promise.reject(
        new Error(`${label} index`)
      ) as never;
      Object.defineProperty(candidate, "model", {
        configurable: true,
        enumerable: true,
        value: Promise.reject(new Error(`${label} model`)),
      });
      candidate.probeLease = Promise.reject(
        new Error(`${label} lease`)
      ) as never;
    };
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["ok"])],
      {
        acquireCandidate: (candidate) => {
          mutate(candidate, "acquire");
          return 1;
        },
        candidateAvailable: (candidate) => {
          mutate(candidate, "available");
          return true;
        },
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected mutations on a discarded capacity-wait snapshot", async () => {
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), textModel(["ok"])],
      {
        acquireCandidate: () => undefined,
        waitForCandidate: (candidate) => {
          candidate.entry = Promise.reject(new Error("wait entry")) as never;
          candidate.probeLease = Promise.reject(
            new Error("wait lease")
          ) as never;
          return Promise.resolve(1);
        },
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("pre-consumes direct createFallbackStream argument siblings before firstResult access", async () => {
    let firstResultReads = 0;
    const args = Object.defineProperties(
      {
        onError: Promise.reject(new Error("async direct sibling")),
      },
      {
        firstResult: {
          get() {
            firstResultReads += 1;
            throw new Error("first result unavailable");
          },
        },
      }
    ) as unknown as FallbackStreamArgs;

    expect(() => createFallbackStream(args, () => undefined)).toThrowError(
      "first result unavailable"
    );
    expect(firstResultReads).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
