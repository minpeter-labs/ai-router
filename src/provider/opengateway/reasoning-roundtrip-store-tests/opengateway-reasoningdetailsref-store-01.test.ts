import { afterEach, describe, expect, it, vi } from "vitest";
import { withReasoningDetailsOnPrompt } from "../reasoning-roundtrip-input";
import {
  captureReasoningStreamPart,
  withReasoningDetailsOnContent,
  withReasoningPartMetadata,
} from "../reasoning-roundtrip-output";
import type { OpenGatewayReasoningDetailsStore } from "../reasoning-roundtrip-store";
import { createOpenGatewayReasoningDetailsStore } from "../reasoning-roundtrip-store";
import {
  laterReasoningDetails,
  opengatewayReasoningRefPattern,
  opengatewayReasoningRefPrefixPattern,
  reasoningDetails,
} from "./test-kit";

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
});
