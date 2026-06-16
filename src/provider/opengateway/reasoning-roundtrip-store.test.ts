import { describe, expect, it } from "vitest";
import { createOpenGatewayReasoningDetailsStore } from "./reasoning-roundtrip-store";

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
});
