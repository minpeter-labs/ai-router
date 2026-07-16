import { describe, expect, it } from "vitest";
import { createOpenGatewayMetadataExtractor } from "../metadata";
import {
  appendUniqueJsonDetails,
  collectChoiceReasoningDetails,
} from "../metadata-details";

describe("OpenGateway reasoning metadata", () => {
  it("bounds and snapshots reasoning details without custom iterators", () => {
    let iterations = 0;
    const details = [{ text: "kept", type: "summary" }];
    Object.defineProperty(details, Symbol.iterator, {
      value() {
        iterations += 1;
        throw new Error("iterator must not run");
      },
    });
    const choices = [{ message: { reasoning_details: details } }];
    Object.defineProperty(choices, Symbol.iterator, {
      value() {
        iterations += 1;
        throw new Error("iterator must not run");
      },
    });

    const collected = collectChoiceReasoningDetails({ choices });
    details[0].text = "mutated";

    expect(collected).toEqual([{ text: "kept", type: "summary" }]);
    expect(iterations).toBe(0);
  });

  it("ignores cyclic and individually oversized reasoning details", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const target: import("@ai-sdk/provider").JSONValue[] = [];

    appendUniqueJsonDetails(target, [
      { text: "kept", type: "summary" },
      { type: "summary", text: "kept" },
      circular,
      "x".repeat(65_537),
    ]);

    expect(target).toEqual([{ text: "kept", type: "summary" }]);
  });

  it("consumes Promise-valued raw metadata body branches", async () => {
    expect(
      collectChoiceReasoningDetails(
        Promise.reject(new Error("async metadata body"))
      )
    ).toEqual([]);
    expect(
      collectChoiceReasoningDetails({
        choices: [
          Promise.reject(new Error("async choice one")),
          Promise.reject(new Error("async choice two")),
        ],
      })
    ).toEqual([]);

    const extractor = createOpenGatewayMetadataExtractor();
    await expect(
      extractor.extractMetadata({
        parsedBody: {
          extra: {
            routing: Promise.reject(new Error("async routing")),
          },
        },
      })
    ).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("bounds custom metadata providers before reading values", async () => {
    let reads = 0;
    const metadata = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [
        `provider-${index}`,
        { marker: index },
      ])
    );
    const hostile = new Proxy(metadata, {
      get(target, key, receiver) {
        if (typeof key === "string" && key.startsWith("provider-")) {
          reads += 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const extractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor: () => ({
        buildMetadata: () => hostile as never,
        processChunk: () => undefined,
      }),
      extractMetadata: () => Promise.resolve(hostile as never),
    });

    await expect(
      extractor.extractMetadata({
        parsedBody: { extra: { routing: { route: "safe" } } },
      })
    ).resolves.toEqual({ opengateway: { routing: { route: "safe" } } });
    expect(reads).toBe(0);
  });

  it("ignores cyclic custom metadata and preserves special provider keys", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidExtractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor: () => ({
        buildMetadata: () => ({ custom: cyclic }) as never,
        processChunk: () => undefined,
      }),
      extractMetadata: () => Promise.resolve({ custom: cyclic } as never),
    });
    await expect(
      invalidExtractor.extractMetadata({
        parsedBody: { extra: { routing: { route: "safe" } } },
      })
    ).resolves.toEqual({ opengateway: { routing: { route: "safe" } } });

    const special = Object.create(null);
    Object.defineProperty(special, "__proto__", {
      enumerable: true,
      value: { marker: "safe" },
    });
    const specialExtractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor: () => ({
        buildMetadata: () => special,
        processChunk: () => undefined,
      }),
      extractMetadata: () => Promise.resolve(special),
    });
    const metadata = await specialExtractor.extractMetadata({ parsedBody: {} });

    expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
    expect(Object.hasOwn(metadata ?? {}, "__proto__")).toBe(true);
    expect(Reflect.get(metadata ?? {}, "__proto__")).toEqual({
      marker: "safe",
    });
  });

  it("isolates failing optional metadata hooks", async () => {
    const extractor = createOpenGatewayMetadataExtractor({
      createStreamExtractor() {
        return {
          buildMetadata() {
            throw new Error("build failed");
          },
          processChunk() {
            throw new Error("chunk failed");
          },
        };
      },
      extractMetadata() {
        return Promise.reject(new Error("extract failed"));
      },
    });

    await expect(
      extractor.extractMetadata({
        parsedBody: { extra: { routing: { route: "generate" } } },
      })
    ).resolves.toEqual({
      opengateway: { routing: { route: "generate" } },
    });

    const stream = extractor.createStreamExtractor();
    expect(() =>
      stream.processChunk({ extra: { routing: { route: "stream" } } })
    ).not.toThrow();
    expect(stream.buildMetadata()).toEqual({
      opengateway: { routing: { route: "stream" } },
    });
  });
});
