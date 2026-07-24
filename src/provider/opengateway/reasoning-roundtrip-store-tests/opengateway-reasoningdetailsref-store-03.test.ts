import { afterEach, describe, expect, it, vi } from "vitest";
import { withReasoningDetailsOnPrompt } from "../reasoning-roundtrip-input";
import { withReasoningDetailsOnContent } from "../reasoning-roundtrip-output";
import {
  captureOpenGatewayReasoningDetailsStore,
  createOpenGatewayReasoningDetailsStoreMemo,
} from "../reasoning-roundtrip-store";
import { reasoningDetails } from "./test-kit";

describe("OpenGateway reasoningDetailsRef store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("consumes invalid refs and snapshots details before custom store calls", async () => {
    let loadCalls = 0;
    const stored: unknown[] = [];
    const captured = captureOpenGatewayReasoningDetailsStore({
      load: () => {
        loadCalls += 1;
        return reasoningDetails;
      },
      store(details) {
        stored.push(details);
        return "stable-ref";
      },
    });

    expect(
      captured.load(Promise.reject(new Error("async ref")) as never)
    ).toBeUndefined();
    const details = [
      Promise.reject(new Error("async detail")),
      reasoningDetails[0],
    ];
    expect(captured.store(details as never)).toBe("stable-ref");
    details[1] = { mutated: true } as never;
    expect(stored).toEqual([[reasoningDetails[0]]]);
    expect(loadCalls).toBe(0);

    const memo = createOpenGatewayReasoningDetailsStoreMemo(captured);
    expect(
      memo.load(Promise.reject(new Error("async memo ref")) as never)
    ).toBeUndefined();
    expect(() =>
      memo.store(Promise.reject(new Error("async memo details")) as never)
    ).toThrow("details must be synchronous array");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots custom load results and validates refs at capture", async () => {
    const syncDetails = [reasoningDetails[0]];
    const sync = captureOpenGatewayReasoningDetailsStore({
      load: () => syncDetails,
      store: () => "stable-ref",
    });
    const loaded = sync.load("ref");
    syncDetails[0] = { mutated: true } as never;
    expect(loaded).toEqual(reasoningDetails);

    const asyncStore = captureOpenGatewayReasoningDetailsStore({
      load: () =>
        Promise.resolve([
          Promise.reject(new Error("async loaded detail")),
          reasoningDetails[0],
        ] as never),
      store: () => Promise.resolve(""),
    });
    await expect(asyncStore.load("ref")).resolves.toEqual(reasoningDetails);
    await expect(asyncStore.store(reasoningDetails)).rejects.toThrow(
      "returned an invalid ref"
    );
    expect(() =>
      captureOpenGatewayReasoningDetailsStore({
        load: () => undefined,
        store: () => "",
      }).store(reasoningDetails)
    ).toThrow("returned an invalid ref");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes Promise-valued store method siblings before accessor failures", async () => {
    const store = Object.defineProperties(
      {},
      {
        load: {
          get() {
            throw new Error("load accessor failed");
          },
        },
        store: {
          value: Promise.reject(new Error("async store method slot")),
        },
      }
    );

    expect(() =>
      captureOpenGatewayReasoningDetailsStore(store as never)
    ).toThrow("load accessor failed");
    expect(() =>
      captureOpenGatewayReasoningDetailsStore(
        Promise.reject(new Error("async store object")) as never
      )
    ).toThrow("reasoningDetailsStore must be synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("captures prompt-replay store accessors once", async () => {
    let loadReads = 0;
    const customStore = {
      get load() {
        loadReads += 1;
        return () => reasoningDetails;
      },
      store: () => "stable-ref",
    };
    const captured = captureOpenGatewayReasoningDetailsStore(customStore);

    expect(await captured.load("first")).toEqual(reasoningDetails);
    expect(await captured.load("second")).toEqual(reasoningDetails);
    expect(loadReads).toBe(1);
  });

  it("does not consult arbitrary custom-store thenable extensions", async () => {
    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    const captured = captureOpenGatewayReasoningDetailsStore({
      load: () => extension as never,
      store: () => extension as never,
    });

    await expect(captured.load("ref")).rejects.toThrow("genuine Promise");
    await expect(captured.store(reasoningDetails)).rejects.toThrow(
      "genuine Promise"
    );
    expect(thenReads).toBe(0);
  });

  it("bounds never-settling optional store operations", async () => {
    vi.useFakeTimers();
    try {
      const captured = captureOpenGatewayReasoningDetailsStore({
        load: () => new Promise(() => undefined),
        store: () => new Promise(() => undefined),
      });
      const content = withReasoningDetailsOnContent(
        [{ text: "answer", type: "text" }],
        reasoningDetails,
        captured
      );
      const prompt = withReasoningDetailsOnPrompt(
        [
          {
            content: [{ text: "answer", type: "text" }],
            providerOptions: { opengateway: { reasoningDetailsRef: "ref" } },
            role: "assistant",
          },
        ],
        captured
      );

      await vi.advanceTimersByTimeAsync(1000);
      await expect(content).resolves.toEqual([
        { text: "answer", type: "text" },
      ]);
      await expect(prompt).resolves.toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes store promises when timeout registration is unavailable", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const captured = captureOpenGatewayReasoningDetailsStore({
      load: () => Promise.reject(new Error("load rejected")),
      store: () => Promise.reject(new Error("store rejected")),
    });
    vi.stubGlobal("setTimeout", () => {
      throw new Error("timer unavailable");
    });
    try {
      await expect(captured.load("ref")).rejects.toThrow(
        "platform timer is unavailable"
      );
      await expect(captured.store(reasoningDetails)).rejects.toThrow(
        "platform timer is unavailable"
      );
      await Promise.resolve();
    } finally {
      vi.stubGlobal("setTimeout", originalSetTimeout);
    }
  });

  it("deduplicates repeated ref loads and bounds unique memo entries", async () => {
    let loads = 0;
    const memo = createOpenGatewayReasoningDetailsStoreMemo({
      load: () => {
        loads += 1;
        return reasoningDetails;
      },
      store: () => "ref",
    });

    await Promise.all([memo.load("same"), memo.load("same")]);
    const unique = Array.from({ length: 1025 }, (_, index) =>
      memo.load(`ref-${index}`)
    );
    await Promise.all(unique);
    expect(loads).toBe(1024);
    expect(unique.at(-1)).toBeUndefined();
  });
});
