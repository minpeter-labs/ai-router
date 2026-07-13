import { describe, expect, it } from "vitest";
import { errorPartModel, runFallback, textModel } from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("hands off and releases a probe lease set before preparation throws", async () => {
    const released: Array<{ fullIndex: number; key?: string }> = [];
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["must not run"]),
      ],
      {
        acquireCandidate: () => 1,
        prepareCandidate: (candidate) => {
          candidate.probeLease = { key: "claimed", probingUntil: 123 };
          throw new Error("prepare failed after claim");
        },
        releaseProbeCandidate: (candidate) => {
          released.push({
            fullIndex: candidate.fullIndex,
            key: candidate.probeLease?.key,
          });
          candidate.probeLease = undefined;
        },
      }
    );

    expect(out.error).toMatchObject({
      message: "prepare failed after claim",
    });
    expect(released).toEqual([
      { fullIndex: 0, key: undefined },
      { fullIndex: 1, key: "claimed" },
    ]);
  });

  it.each([
    [
      "container",
      () => Promise.reject(new Error("async lease container")) as never,
    ],
    [
      "fields",
      () =>
        ({
          key: Promise.reject(new Error("async lease key")),
          probingUntil: Promise.reject(new Error("async lease deadline")),
        }) as never,
    ],
  ])("consumes rejected Promise-valued probe lease %s", async (_name, lease) => {
    const out = await runFallback(
      [
        errorPartModel(new Error("primary failed")),
        textModel(["must not run"]),
      ],
      {
        acquireCandidate: () => 1,
        prepareCandidate: (candidate) => {
          candidate.probeLease = lease();
          return true;
        },
      }
    );

    expect(out.error).toMatchObject({
      message: "ai-router: stream candidate 1 probe lease is invalid",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("releases a partially prepared probe when preparation declines admission", async () => {
    const releasedProbes: number[] = [];
    const survivor = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: () => 1,
        prepareCandidate: (candidate) => {
          candidate.probeLease = { key: "partial", probingUntil: 123 };
          return false;
        },
        releaseProbeCandidate: (candidate) => {
          releasedProbes.push(candidate.fullIndex);
          candidate.probeLease = undefined;
        },
      }
    );

    expect(out.error).toMatchObject({ message: "primary failed" });
    expect(survivor.doStreamCalls).toHaveLength(0);
    expect(releasedProbes).toEqual([0, 1]);
  });

  it("isolates prepared candidate identity while handing off its probe lease", async () => {
    const acquired: number[] = [];
    const releasedProbes: Array<{ fullIndex: number; key?: string }> = [];
    const survivor = textModel(["ok"]);
    const replacement = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: ({ fullIndex }) => {
          acquired.push(fullIndex);
          return 1;
        },
        prepareCandidate: (candidate) => {
          candidate.fullIndex = 999;
          candidate.entry = replacement;
          Object.defineProperty(candidate, "model", {
            configurable: true,
            enumerable: true,
            value: replacement,
          });
          candidate.probeLease = { key: "prepared", probingUntil: 123 };
          return true;
        },
        releaseProbeCandidate: (candidate) => {
          releasedProbes.push({
            fullIndex: candidate.fullIndex,
            key: candidate.probeLease?.key,
          });
          candidate.probeLease = undefined;
        },
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("ok");
    expect(acquired).toEqual([1]);
    expect(releasedProbes).toEqual([
      { fullIndex: 0, key: undefined },
      { fullIndex: 1, key: "prepared" },
    ]);
    expect(replacement.doStreamCalls).toHaveLength(0);
  });

  it("releases waited capacity and a partially re-prepared declined probe", async () => {
    let preparations = 0;
    const releasedCapacity: number[] = [];
    const releasedProbes: Array<{
      fullIndex: number;
      source?: "local";
    }> = [];
    const survivor = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: () => undefined,
        prepareCandidate: (candidate) => {
          preparations += 1;
          candidate.probeLease = {
            key: "partial",
            probingUntil: 123,
            source: "local",
          };
          return preparations === 1;
        },
        releaseCandidate: ({ fullIndex }) => releasedCapacity.push(fullIndex),
        releaseProbeCandidate: (candidate) => {
          releasedProbes.push({
            fullIndex: candidate.fullIndex,
            source: candidate.probeLease?.source,
          });
          candidate.probeLease = undefined;
        },
        waitForCandidate: () => Promise.resolve(1),
      }
    );

    expect(out.error).toMatchObject({ message: "primary failed" });
    expect(survivor.doStreamCalls).toHaveLength(0);
    expect(releasedCapacity).toEqual([0, 1]);
    expect(releasedProbes).toEqual([
      { fullIndex: 0, source: undefined },
      { fullIndex: 1, source: "local" },
      { fullIndex: 1, source: "local" },
    ]);
  });

  it("isolates probe cleanup identity mutation before capacity waiting", async () => {
    const prepared: number[] = [];
    const waited: number[] = [];
    const released: number[] = [];
    const survivor = textModel(["ok"]);
    const replacement = textModel(["must not run"]);
    const out = await runFallback(
      [errorPartModel(new Error("primary failed")), survivor],
      {
        acquireCandidate: () => undefined,
        prepareCandidate: (candidate) => {
          prepared.push(candidate.fullIndex);
          candidate.probeLease = { key: "probe", probingUntil: 123 };
          return true;
        },
        releaseProbeCandidate: (candidate) => {
          released.push(candidate.fullIndex);
          candidate.fullIndex = 999;
          candidate.entry = replacement;
          Object.defineProperty(candidate, "model", {
            configurable: true,
            enumerable: true,
            value: replacement,
          });
          candidate.probeLease = undefined;
        },
        waitForCandidate: (candidate) => {
          waited.push(candidate.fullIndex);
          return Promise.resolve(1);
        },
      }
    );

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("ok");
    expect(prepared).toEqual([1, 1]);
    expect(waited).toEqual([1]);
    expect(released).toEqual([0, 1, 1]);
    expect(replacement.doStreamCalls).toHaveLength(0);
  });
});
