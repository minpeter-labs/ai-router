import { describe, expect, it } from "vitest";
import { captureProviderMetadataExtractor } from "../provider-settings-metadata";

describe("captureProviderMetadataExtractor", () => {
  it("isolates generate and stream hook inputs from SDK-owned values", async () => {
    const generateBody = { nested: { stable: true } };
    const streamChunk = { nested: { stable: true } };
    const captured = captureProviderMetadataExtractor(
      {
        createStreamExtractor: () => ({
          buildMetadata: () => undefined,
          processChunk(parsedChunk) {
            (parsedChunk as typeof streamChunk).nested.stable = false;
          },
        }),
        extractMetadata({ parsedBody }) {
          (parsedBody as typeof generateBody).nested.stable = false;
          return Promise.resolve(undefined);
        },
      },
      "TestProvider"
    );

    await captured?.extractMetadata({ parsedBody: generateBody });
    captured?.createStreamExtractor().processChunk(streamChunk);

    expect(generateBody.nested.stable).toBe(true);
    expect(streamChunk.nested.stable).toBe(true);
  });

  it("skips optional hooks for asynchronous or non-JSON inputs", async () => {
    let generateCalls = 0;
    let streamCalls = 0;
    const captured = captureProviderMetadataExtractor(
      {
        createStreamExtractor: () => ({
          buildMetadata: () => undefined,
          processChunk() {
            streamCalls += 1;
          },
        }),
        extractMetadata() {
          generateCalls += 1;
          return Promise.resolve(undefined);
        },
      },
      "TestProvider"
    );

    await expect(
      captured?.extractMetadata({
        parsedBody: { async: Promise.reject(new Error("async body")) },
      })
    ).resolves.toBeUndefined();
    captured
      ?.createStreamExtractor()
      .processChunk({ async: Promise.reject(new Error("async chunk")) });

    expect(generateCalls).toBe(0);
    expect(streamCalls).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes root and stream method Promise siblings", async () => {
    const malformed = Object.defineProperties(
      {},
      {
        createStreamExtractor: {
          get() {
            throw new Error("stream accessor failed");
          },
        },
        extractMetadata: {
          value: Promise.reject(new Error("async extract method")),
        },
      }
    );
    expect(() =>
      captureProviderMetadataExtractor(malformed as never, "TestProvider")
    ).toThrow("stream accessor failed");

    const captured = captureProviderMetadataExtractor(
      {
        createStreamExtractor: () =>
          ({
            buildMetadata: Promise.reject(new Error("async build method")),
            processChunk: Promise.reject(new Error("async process method")),
          }) as never,
        extractMetadata: () => Promise.resolve(undefined),
      },
      "TestProvider"
    );
    const stream = captured?.createStreamExtractor();
    expect(() => stream?.processChunk({})).not.toThrow();
    expect(stream?.buildMetadata()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("preserves receivers and isolates async or malformed metadata results", async () => {
    let rootReceiver = false;
    let streamReceiver = false;
    const streamSource = {
      buildMetadata(this: unknown) {
        streamReceiver = this === streamSource;
        return {
          custom: {
            nested: Promise.reject(new Error("async stream metadata")),
          },
        } as never;
      },
      processChunk(this: unknown) {
        streamReceiver = this === streamSource;
        return Promise.reject(new Error("async process result")) as never;
      },
    };
    const source = {
      createStreamExtractor(this: unknown) {
        rootReceiver = this === source;
        return streamSource;
      },
      extractMetadata(this: unknown) {
        rootReceiver = this === source;
        return Promise.resolve({
          custom: {
            nested: Promise.reject(new Error("async generate metadata")),
          },
        } as never);
      },
    };
    const captured = captureProviderMetadataExtractor(source, "TestProvider");

    await expect(
      captured?.extractMetadata({ parsedBody: {} })
    ).resolves.toBeUndefined();
    const stream = captured?.createStreamExtractor();
    stream?.processChunk({});
    expect(stream?.buildMetadata()).toBeUndefined();
    expect(rootReceiver).toBe(true);
    expect(streamReceiver).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
