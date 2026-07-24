import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
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
  it("captures admission hook accessors once with their receiver", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    const survivor = textModel(["ok"]);
    const candidates = [resolved(primary, 0), resolved(survivor, 1)];
    const originalProbeLease = {
      key: "stable",
      probingUntil: 1234,
      source: "local" as const,
    };
    candidates[1].probeLease = originalProbeLease;
    const firstResult = await primary.doStream(callOptions);
    const reads = {
      acquire: 0,
      available: 0,
      firstResult: 0,
      maxAttempts: 0,
      success: 0,
    };
    let priorErrorIteratorReads = 0;
    let priorErrorIndexReads = 0;
    const priorErrors = [new Error("earlier open failed")];
    Object.defineProperties(priorErrors, {
      0: {
        configurable: true,
        get() {
          priorErrorIndexReads += 1;
          throw new Error("prior error index must not run");
        },
      },
      [Symbol.iterator]: {
        get() {
          priorErrorIteratorReads += 1;
          throw new Error("prior error iterator must not run");
        },
      },
    });
    const args: FallbackStreamArgs = {
      candidates,
      firstResult,
      logicalId: "chat",
      options: callOptions,
      priorErrors,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    };
    Object.defineProperties(args, {
      acquireCandidate: {
        configurable: true,
        get() {
          reads.acquire += 1;
          return function (this: unknown) {
            expect(this).toBe(args);
            return 1;
          };
        },
      },
      candidateAvailable: {
        configurable: true,
        get() {
          reads.available += 1;
          return function (this: unknown) {
            expect(this).toBe(args);
            return true;
          };
        },
      },
      firstResult: {
        configurable: true,
        get() {
          reads.firstResult += 1;
          return firstResult;
        },
      },
      maxAttempts: {
        configurable: true,
        get() {
          reads.maxAttempts += 1;
          return 2;
        },
      },
      onCandidateSuccess: {
        configurable: true,
        get() {
          reads.success += 1;
          return function (this: unknown, candidate: ResolvedEntry) {
            expect(this).toBe(args);
            expect(candidate.probeLease).toEqual({
              key: "stable",
              probingUntil: 1234,
              source: "local",
            });
            return;
          };
        },
      },
    });

    const wrapped = wrapStreamResult(args);
    const mutated = textModel(["mutated candidate must not run"]);
    const fallbackCandidate = candidates[1];
    candidates[1] = resolved(mutated, 1);
    fallbackCandidate.entry = mutated;
    fallbackCandidate.fullIndex = 999;
    fallbackCandidate.model = mutated;
    originalProbeLease.key = "mutated";
    originalProbeLease.probingUntil = 9999;
    Object.defineProperties(args, {
      acquireCandidate: {
        value: () => {
          throw new Error("mutated acquire hook must not run");
        },
      },
      candidateAvailable: {
        value: () => {
          throw new Error("mutated availability hook must not run");
        },
      },
      firstResult: {
        value: {
          stream: new ReadableStream<LanguageModelV4StreamPart>(),
        },
      },
      maxAttempts: { value: 1 },
      onCandidateSuccess: {
        value: () => {
          throw new Error("mutated success hook must not run");
        },
      },
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(mutated.doStreamCalls).toHaveLength(0);
    expect(priorErrorIndexReads).toBe(0);
    expect(priorErrorIteratorReads).toBe(0);
    expect(reads).toEqual({
      acquire: 1,
      available: 1,
      firstResult: 1,
      maxAttempts: 1,
      success: 1,
    });
  });

  it("snapshots call options before opening a fallback provider", async () => {
    const primary = errorPartModel(new Error("primary failed"));
    let fallbackPrompt: unknown;
    const survivor = new MockLanguageModelV4({
      doStream: (options) => {
        fallbackPrompt = options.prompt;
        return textModel(["ok"]).doStream(options);
      },
    });
    const candidates = [resolved(primary, 0), resolved(survivor, 1)];
    const options = {
      ...callOptions,
      prompt: [
        {
          content: [{ text: "stable", type: "text" as const }],
          role: "user" as const,
        },
      ],
    } as LanguageModelV4CallOptions;
    const firstResult = await primary.doStream(options);
    const requestBody = { prompt: "stable request metadata" };
    firstResult.request = { body: requestBody };
    const wrapped = wrapStreamResult({
      candidates,
      firstResult,
      logicalId: "chat",
      options,
      retryAfterOutput: false,
      shouldRetry: defaultShouldRetryThisError,
      startIndex: 0,
    });
    const firstPrompt = options.prompt[0] as {
      content: Array<{ text: string }>;
    };
    firstPrompt.content[0].text = "mutated";
    requestBody.prompt = "mutated request metadata";
    expect(wrapped.request).toEqual({
      body: { prompt: "stable request metadata" },
    });
    const exposedRequest = wrapped.request as {
      body: { prompt: string };
    };
    exposedRequest.body.prompt = "consumer mutation";
    expect(wrapped.request).toEqual({
      body: { prompt: "stable request metadata" },
    });

    await expect(drive(wrapped.stream)).resolves.toMatchObject({ text: "ok" });
    expect(fallbackPrompt).toEqual([
      {
        content: [{ text: "stable", type: "text" }],
        role: "user",
      },
    ]);
  });
});
