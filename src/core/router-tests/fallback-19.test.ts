import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { generateText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import { asV4, finishReason, genOptions, okModel, usage } from "./test-kit";

describe("createRouter — fallback", () => {
  it("aborts while waiting for a concurrency slot", async () => {
    let resolveFirst:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    const model = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    });
    const route = createRouter({
      fallback: { concurrencyWaitTimeout: 1000 },
      models: { chat: [{ model, maxConcurrency: 1 }] },
    });
    const first = generateText({ model: route("chat"), prompt: "first" });
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));
    const controller = new AbortController();
    const waiting = asV4(route("chat")).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "wait" }] }],
      abortSignal: controller.signal,
    } as LanguageModelV4CallOptions);
    controller.abort(new DOMException("aborted", "AbortError"));

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    resolveFirst?.({
      content: [{ type: "text", text: "done" }],
      finishReason,
      usage,
      warnings: [],
    });
    await first;
  });

  it("releases waited capacity when post-wait probe preparation throws", async () => {
    let resolveFirst:
      | ((value: LanguageModelV4GenerateResult) => void)
      | undefined;
    let calls = 0;
    const provider = new MockLanguageModelV4({
      doGenerate: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          finishReason,
          usage,
          warnings: [],
        });
      },
    });
    const route = createRouter({
      fallback: { concurrencyWaitTimeout: 1000 },
      models: { chat: [{ model: provider, maxConcurrency: 1 }] },
    });
    const routedModel = asV4(route("chat"));
    const first = routedModel.doGenerate(genOptions);
    await vi.waitFor(() => expect(provider.doGenerateCalls).toHaveLength(1));

    const originalPrepare = Reflect.get(routedModel, "prepareCandidate");
    let preparations = 0;
    Reflect.set(
      routedModel,
      "prepareCandidate",
      function (this: unknown, candidate: unknown) {
        preparations += 1;
        if (preparations === 2) {
          throw new Error("post-wait preparation failed");
        }
        return Reflect.apply(originalPrepare, this, [candidate]);
      }
    );
    const waiting = routedModel.doGenerate(genOptions);
    await vi.waitFor(() =>
      expect(route.getAdmissionSnapshot("chat")[0].waiting).toBe(1)
    );
    resolveFirst?.({
      content: [{ type: "text", text: "first" }],
      finishReason,
      usage,
      warnings: [],
    });
    await first;

    await expect(waiting).rejects.toMatchObject({
      message: "post-wait preparation failed",
    });
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);

    Reflect.set(routedModel, "prepareCandidate", originalPrepare);
    await expect(routedModel.doGenerate(genOptions)).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("releases stream-open capacity when failure handling throws", async () => {
    let calls = 0;
    const provider = new MockLanguageModelV4({
      doStream: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error("open failed"));
        }
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "ok" },
              { type: "text-end", id: "1" },
              { type: "finish", finishReason, usage },
            ],
          }),
        });
      },
    });
    const route = createRouter({
      models: { chat: [{ model: provider, maxConcurrency: 1 }] },
    });
    const routedModel = asV4(route("chat"));
    const originalHandleFailure = Reflect.get(routedModel, "handleFailure");
    Reflect.set(routedModel, "handleFailure", () => {
      throw new Error("failure handling failed");
    });

    await expect(routedModel.doStream(genOptions)).rejects.toMatchObject({
      message: "failure handling failed",
    });
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);

    Reflect.set(routedModel, "handleFailure", originalHandleFailure);
    const result = await routedModel.doStream(genOptions);
    const reader = result.stream.getReader();
    while (!(await reader.read()).done) {
      // Drain the successful stream so terminal cleanup releases ownership.
    }
    expect(route.getAdmissionSnapshot("chat")[0].inFlight).toBe(0);
  });

  it("keeps capacity and probe cleanup independent under infrastructure throws", () => {
    const provider = okModel();
    const route = createRouter({ models: { chat: [provider] } });
    const routedModel = asV4(route("chat"));
    const admission = Reflect.get(routedModel, "admission");
    const health = Reflect.get(routedModel, "health");
    const originalAdmissionRelease = Reflect.get(admission, "release");
    const originalHealthRelease = Reflect.get(health, "releaseProbe");
    const releasedLeases: unknown[] = [];
    const candidate = {
      entry: provider,
      fullIndex: 0,
      model: provider,
      probeLease: { key: "probe", probingUntil: 123 },
    };
    Reflect.set(admission, "release", () => {
      throw new Error("capacity cleanup failed");
    });
    Reflect.set(health, "releaseProbe", (lease: unknown) => {
      releasedLeases.push(lease);
    });

    expect(() =>
      Reflect.apply(
        Reflect.get(routedModel, "releaseCandidateOwnership"),
        routedModel,
        [candidate]
      )
    ).toThrow("capacity cleanup failed");
    expect(releasedLeases).toEqual([{ key: "probe", probingUntil: 123 }]);
    expect(candidate.probeLease).toBeUndefined();

    candidate.probeLease = { key: "second", probingUntil: 456 };
    Reflect.set(admission, "release", originalAdmissionRelease);
    Reflect.set(health, "releaseProbe", () => {
      throw new Error("probe cleanup failed");
    });
    expect(() =>
      Reflect.apply(
        Reflect.get(routedModel, "releaseCandidateProbe"),
        routedModel,
        [candidate]
      )
    ).toThrow("probe cleanup failed");
    expect(candidate.probeLease).toBeUndefined();

    Reflect.set(health, "releaseProbe", originalHealthRelease);
  });
});
