import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureOpenGatewayReasoningDetailsStore,
  createOpenGatewayReasoningDetailsStore,
  createOpenGatewayReasoningDetailsStoreMemo,
} from "../reasoning-roundtrip-store";
import { laterReasoningDetails, reasoningDetails } from "./test-kit";

describe("OpenGateway reasoningDetailsRef store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
