import { afterEach, describe, expect, it, vi } from "vitest";
import { withReasoningDetailsOnPrompt } from "./reasoning-roundtrip-input";
import {
  captureReasoningStreamPart,
  withReasoningDetailsOnContent,
  withReasoningPartMetadata,
} from "./reasoning-roundtrip-output";
import type { OpenGatewayReasoningDetailsStore } from "./reasoning-roundtrip-store";
import {
  captureOpenGatewayReasoningDetailsStore,
  createOpenGatewayReasoningDetailsStore,
  createOpenGatewayReasoningDetailsStoreMemo,
} from "./reasoning-roundtrip-store";

const reasoningDetails = [
  { data: "encrypted-mini", format: "minimax", type: "reasoning.encrypted" },
];
const laterReasoningDetails = [
  { data: "encrypted-later", format: "minimax", type: "reasoning.encrypted" },
];

const opengatewayReasoningRefPattern =
  /^opengateway-reasoning-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const opengatewayReasoningRefPrefixPattern = /^opengateway-reasoning-/;

describe("OpenGateway reasoningDetailsRef store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("isolates optional store save and load failures", async () => {
    const failingStore: OpenGatewayReasoningDetailsStore = {
      load: () => Promise.reject(new Error("load unavailable")),
      store: () => Promise.reject(new Error("store unavailable")),
    };

    const content = await withReasoningDetailsOnContent(
      [{ text: "answer", type: "text" }],
      reasoningDetails,
      failingStore
    );
    expect(content[0].providerMetadata).toBeUndefined();

    const prompt = await withReasoningDetailsOnPrompt(
      [
        {
          content: [{ text: "answer", type: "text" }],
          providerOptions: {
            opengateway: { reasoningDetailsRef: "missing" },
          },
          role: "assistant",
        },
      ],
      failingStore
    );
    expect(prompt[0]).not.toHaveProperty(
      "providerOptions.openaiCompatible.reasoning_details"
    );
  });

  it("captures replay prompts before async loads and consumes cross-argument siblings", async () => {
    const prompt = [
      {
        content: [
          {
            providerOptions: {
              opengateway: { reasoningDetailsRef: "stable-ref" },
            },
            text: "stable",
            type: "text" as const,
          },
        ],
        role: "assistant" as const,
      },
    ];
    const pending = withReasoningDetailsOnPrompt(prompt, {
      load: () => Promise.resolve(reasoningDetails),
      store: () => "unused",
    });
    prompt[0].content[0].text = "mutated";

    await expect(pending).resolves.toMatchObject([
      {
        content: [{ text: "stable" }],
        providerOptions: {
          openaiCompatible: { reasoning_details: reasoningDetails },
        },
      },
    ]);

    await expect(
      withReasoningDetailsOnPrompt(
        [Promise.reject(new Error("async prompt entry"))] as never,
        {
          load: Promise.reject(new Error("async load method")),
          store: Promise.reject(new Error("async store method")),
        } as never
      )
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("ignores malformed refs returned by a custom store", async () => {
    const malformedStore: OpenGatewayReasoningDetailsStore = {
      load: () => undefined,
      store: (() => 42) as never,
    };
    const content = await withReasoningDetailsOnContent(
      [{ text: "answer", type: "text" }],
      reasoningDetails,
      malformedStore
    );

    expect(content[0].providerMetadata).toBeUndefined();
  });

  it("consumes content and stream part Promise siblings without inactive access", async () => {
    let inactiveReads = 0;
    const textPart = Object.defineProperties(
      {
        providerMetadata: Promise.reject(new Error("async metadata")),
        text: Promise.reject(new Error("async text")),
        type: "text",
      },
      {
        data: {
          get() {
            inactiveReads += 1;
            throw new Error("inactive data must not be read");
          },
        },
      }
    );
    await expect(
      withReasoningDetailsOnContent(
        [textPart as never],
        reasoningDetails,
        createOpenGatewayReasoningDetailsStore()
      )
    ).rejects.toThrow("text content part fields must be synchronous");
    expect(inactiveReads).toBe(0);

    expect(() =>
      captureReasoningStreamPart({
        delta: Promise.reject(new Error("async delta")),
        id: "reasoning",
        providerMetadata: Promise.reject(new Error("async stream metadata")),
        type: "reasoning-delta",
      } as never)
    ).toThrow("stream part fields must be synchronous");

    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then must not be inspected");
      },
    });
    expect(
      captureReasoningStreamPart({ type: extension } as never)
    ).toMatchObject({ type: extension });
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots nested provider metadata before attaching reasoning refs", async () => {
    const content = await withReasoningDetailsOnContent(
      [
        {
          providerMetadata: {
            custom: {
              first: Promise.reject(new Error("async metadata first")),
              second: Promise.reject(new Error("async metadata second")),
            },
          },
          text: "answer",
          type: "text",
        } as never,
      ],
      reasoningDetails,
      {
        load: () => undefined,
        store: () => "stable-ref",
      }
    );

    expect(content[0].providerMetadata).toEqual({
      opengateway: { reasoningDetailsRef: "stable-ref" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes and snapshots reasoning-details containers and entries", async () => {
    const seen: unknown[] = [];
    const store: OpenGatewayReasoningDetailsStore = {
      load: () => undefined,
      store(details) {
        seen.push(details);
        return "stable-ref";
      },
    };
    const details = [
      Promise.reject(new Error("async detail entry")),
      reasoningDetails[0],
    ];
    const pending = withReasoningDetailsOnContent(
      [{ text: "answer", type: "text" }],
      details as never,
      store
    );
    details[1] = { mutated: true } as never;

    await expect(pending).resolves.toMatchObject([
      {
        providerMetadata: {
          opengateway: { reasoningDetailsRef: "stable-ref" },
        },
      },
    ]);
    expect(seen).toEqual([[reasoningDetails[0]]]);

    await expect(
      withReasoningPartMetadata(
        { id: "reasoning", type: "reasoning-start" },
        Promise.reject(new Error("async details container")) as never,
        store
      )
    ).resolves.toEqual({ id: "reasoning", type: "reasoning-start" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  it("uses unguessable refs instead of sequential counters", async () => {
    const store = createOpenGatewayReasoningDetailsStore();

    const firstRef = await store.store(reasoningDetails);
    const secondRef = await store.store(laterReasoningDetails);

    expect(firstRef).toMatch(opengatewayReasoningRefPattern);
    expect(secondRef).toMatch(opengatewayReasoningRefPrefixPattern);
    expect(secondRef).not.toBe(firstRef);
    expect(await store.load("opengateway-reasoning-1")).toBeUndefined();
    expect(await store.load(firstRef)).toEqual(reasoningDetails);
  });

  it("evicts expired and overflowing refs", async () => {
    let now = 1000;
    const store = createOpenGatewayReasoningDetailsStore({
      maxEntries: 1,
      now: () => now,
      ttlMs: 50,
    });

    const firstRef = await store.store(reasoningDetails);
    const secondRef = await store.store(laterReasoningDetails);

    expect(await store.load(firstRef)).toBeUndefined();
    expect(await store.load(secondRef)).toEqual(laterReasoningDetails);

    now = 1100;
    expect(await store.load(secondRef)).toBeUndefined();
  });

  it("does not extend TTL when the wall clock moves backwards", async () => {
    let now = 1000;
    const store = createOpenGatewayReasoningDetailsStore({
      now: () => now,
      ttlMs: 50,
    });
    const ref = await store.store(reasoningDetails);

    now = 1040;
    expect(await store.load(ref)).toEqual(reasoningDetails);
    now = 900;
    expect(await store.load(ref)).toEqual(reasoningDetails);
    now = 1050;
    expect(await store.load(ref)).toBeUndefined();
  });

  it("validates bounded settings and clock results", () => {
    expect(() =>
      createOpenGatewayReasoningDetailsStore({ maxEntries: -1 })
    ).toThrow();
    expect(() =>
      createOpenGatewayReasoningDetailsStore({ maxEntries: 100_001 })
    ).toThrow();
    expect(() =>
      createOpenGatewayReasoningDetailsStore({
        ttlMs: Number.POSITIVE_INFINITY,
      })
    ).toThrow();
    expect(() =>
      createOpenGatewayReasoningDetailsStore({ ttlMs: 2_592_000_001 })
    ).toThrow();
    expect(() =>
      createOpenGatewayReasoningDetailsStore({ refPrefix: "bad prefix" })
    ).toThrow();
    const store = createOpenGatewayReasoningDetailsStore({
      now: () => Number.NaN,
    });
    expect(() => store.store(reasoningDetails)).toThrow();
  });

  it("consumes Promise-valued settings before an option accessor fails", async () => {
    const settings = Object.defineProperties(
      {},
      {
        maxEntries: {
          get() {
            throw new Error("maxEntries accessor failed");
          },
        },
        ttlMs: {
          value: Promise.reject(new Error("async ttl sibling")),
        },
      }
    );

    expect(() =>
      createOpenGatewayReasoningDetailsStore(settings as never)
    ).toThrow("maxEntries accessor failed");
    expect(() =>
      createOpenGatewayReasoningDetailsStore(
        Promise.reject(new Error("async settings")) as never
      )
    ).toThrow("reasoningDetailsRef settings must be synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes async clock and random UUID samples without probing thenables", async () => {
    const asyncClock = createOpenGatewayReasoningDetailsStore({
      now: (() => Promise.reject(new Error("async clock"))) as never,
    });
    expect(() => asyncClock.store(reasoningDetails)).toThrow(
      "clock must return a safe integer"
    );

    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID");
    randomUUID.mockReturnValueOnce(
      Promise.reject(new Error("async UUID")) as never
    );
    expect(() =>
      createOpenGatewayReasoningDetailsStore().store(reasoningDetails)
    ).toThrow("randomUUID must return a synchronous bounded string");

    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then must not be inspected");
      },
    });
    randomUUID.mockReturnValueOnce(extension as never);
    expect(() =>
      createOpenGatewayReasoningDetailsStore().store(reasoningDetails)
    ).toThrow("randomUUID must return a synchronous bounded string");
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not overwrite an existing entry when random refs collide", async () => {
    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID");
    randomUUID
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const store = createOpenGatewayReasoningDetailsStore();
    const firstRef = await store.store(reasoningDetails);
    const secondRef = await store.store(laterReasoningDetails);

    expect(secondRef).not.toBe(firstRef);
    expect(await store.load(firstRef)).toEqual(reasoningDetails);
    expect(await store.load(secondRef)).toEqual(laterReasoningDetails);
  });

  it("snapshots details without invoking custom iterators", async () => {
    const details = [reasoningDetails[0]];
    Object.defineProperty(details, Symbol.iterator, {
      value: () => {
        throw new Error("must not iterate");
      },
    });
    const store = createOpenGatewayReasoningDetailsStore();
    const ref = await store.store(details);
    expect(await store.load(ref)).toEqual(reasoningDetails);
  });

  it("retries memoized stores after transient rejection", async () => {
    let attempts = 0;
    const memo = createOpenGatewayReasoningDetailsStoreMemo({
      load: () => undefined,
      store: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("temporary outage"))
          : Promise.resolve("recovered-ref");
      },
    });
    await expect(memo.store(reasoningDetails)).rejects.toThrow(
      "temporary outage"
    );
    await expect(memo.store(reasoningDetails)).resolves.toBe("recovered-ref");
    expect(attempts).toBe(2);
  });

  it("captures custom methods once and preserves their receiver", async () => {
    let storeReads = 0;
    const customStore = {
      prefix: "bound",
      load(this: { prefix: string }, ref: string) {
        return ref === this.prefix ? reasoningDetails : undefined;
      },
      get store() {
        storeReads += 1;
        return function storeWithReceiver(this: { prefix: string }) {
          return `${this.prefix}-ref`;
        };
      },
    };
    const memo = createOpenGatewayReasoningDetailsStoreMemo(customStore);
    await expect(memo.store(reasoningDetails)).resolves.toBe("bound-ref");
    expect(await memo.load("bound")).toEqual(reasoningDetails);
    expect(storeReads).toBe(1);
  });

  it("consumes rejected sync and post-await mutations to custom store input", async () => {
    const captured = captureOpenGatewayReasoningDetailsStore({
      load: () => undefined,
      async store(details) {
        const detail = details[0] as Record<string, unknown>;
        detail.format = Promise.reject(new Error("async sync mutation"));
        await Promise.resolve();
        detail.data = Promise.reject(new Error("async late mutation"));
        return "stable-ref";
      },
    });

    await expect(captured.store(reasoningDetails)).resolves.toBe("stable-ref");
    expect(reasoningDetails[0]).toEqual({
      data: "encrypted-mini",
      format: "minimax",
      type: "reasoning.encrypted",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
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

  it("memoizes semantically identical details across object key order", async () => {
    let stores = 0;
    const memo = createOpenGatewayReasoningDetailsStoreMemo({
      load: () => undefined,
      store: () => {
        stores += 1;
        return "same-ref";
      },
    });
    const first = [{ data: "value", format: "test", type: "reasoning" }];
    const reordered = [{ type: "reasoning", format: "test", data: "value" }];

    await expect(memo.store(first)).resolves.toBe("same-ref");
    await expect(memo.store(reordered)).resolves.toBe("same-ref");
    expect(stores).toBe(1);
  });

  it("bounds prompt replay load concurrency and total wait", async () => {
    vi.useFakeTimers();
    try {
      let loads = 0;
      const memo = createOpenGatewayReasoningDetailsStoreMemo({
        load: () => {
          loads += 1;
          return new Promise(() => undefined);
        },
        store: () => "ref",
      });
      const prompt = Array.from({ length: 100 }, (_, index) => ({
        content: [{ text: "answer", type: "text" as const }],
        providerOptions: {
          opengateway: { reasoningDetailsRef: `ref-${index}` },
        },
        role: "assistant" as const,
      }));
      const transformed = withReasoningDetailsOnPrompt(prompt, memo);
      await Promise.resolve();

      expect(loads).toBe(32);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(transformed).resolves.toHaveLength(100);
      expect(loads).toBe(32);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards partial replay results when the prompt-wide deadline wins", async () => {
    vi.useFakeTimers();
    try {
      let loads = 0;
      const memo = createOpenGatewayReasoningDetailsStoreMemo({
        load: () => {
          loads += 1;
          return loads === 1
            ? Promise.resolve(reasoningDetails)
            : new Promise(() => undefined);
        },
        store: () => "ref",
      });
      const prompt = Array.from({ length: 33 }, (_, index) => ({
        content: [{ text: "answer", type: "text" as const }],
        providerOptions: {
          opengateway: { reasoningDetailsRef: `ref-${index}` },
        },
        role: "assistant" as const,
      }));
      const transformed = withReasoningDetailsOnPrompt(prompt, memo);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(transformed).resolves.toEqual(prompt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed memo refs without caching them", async () => {
    let attempts = 0;
    const memo = createOpenGatewayReasoningDetailsStoreMemo({
      load: () => undefined,
      store: () => {
        attempts += 1;
        return attempts === 1 ? "" : "valid-ref";
      },
    });
    await expect(memo.store(reasoningDetails)).rejects.toThrow("invalid ref");
    await expect(memo.store(reasoningDetails)).resolves.toBe("valid-ref");
  });
});
