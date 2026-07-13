import { describe, expect, it } from "vitest";
import {
  captureProviderConvertUsage,
  captureProviderFetch,
  captureProviderMetadataExtractor,
  captureProviderSupportedUrls,
} from "./provider-settings";

const STABLE_PATTERN = /stable/gi;
const MUTATED_PATTERN = /mutated/;
const SOUND_PATTERN = /sound/u;

describe("captureProviderSupportedUrls", () => {
  it("preserves the callback receiver and snapshots sync and async maps", async () => {
    const patterns = [STABLE_PATTERN];
    const settings = {
      supportedUrls(this: unknown) {
        expect(this).toBe(settings);
        return { "image/*": patterns };
      },
    };
    const captured = captureProviderSupportedUrls(
      settings.supportedUrls,
      "TestProvider",
      settings
    );
    const snapshot = captured?.();
    patterns[0] = MUTATED_PATTERN;
    expect(snapshot).toEqual({ "image/*": [STABLE_PATTERN] });

    const asyncCaptured = captureProviderSupportedUrls(
      () => Promise.resolve({ "audio/*": [SOUND_PATTERN] }),
      "TestProvider",
      settings
    );
    await expect(asyncCaptured?.()).resolves.toEqual({
      "audio/*": [SOUND_PATTERN],
    });
  });

  it("consumes Promise-valued media and pattern siblings", async () => {
    const captured = captureProviderSupportedUrls(
      () =>
        ({
          "audio/*": [
            Promise.reject(new Error("async pattern one")),
            Promise.reject(new Error("async pattern two")),
          ],
          "image/*": Promise.reject(new Error("async media patterns")),
        }) as never,
      "TestProvider",
      {}
    );

    expect(() => captured?.()).toThrow(
      "TestProvider supportedUrls must be synchronous"
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not inspect arbitrary thenable callback results", () => {
    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then must not be inspected");
      },
    });
    const captured = captureProviderSupportedUrls(
      () => extension as never,
      "TestProvider",
      {}
    );

    expect(captured?.()).toEqual({});
    expect(thenReads).toBe(0);
  });
});

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

describe("captureProviderConvertUsage", () => {
  it("isolates callback input from the SDK-owned usage object", () => {
    const usage = { completion_tokens: 2, prompt_tokens: 1 };
    const captured = captureProviderConvertUsage(
      (capturedUsage) => {
        (capturedUsage as typeof usage).prompt_tokens = 999;
        return {
          inputTokens: { total: 1 },
          outputTokens: { total: 2 },
        } as never;
      },
      "TestProvider",
      {}
    );

    captured?.(usage as never);

    expect(usage.prompt_tokens).toBe(1);
  });

  it("rejects asynchronous callback input without probing thenables", async () => {
    let callbackCalls = 0;
    const captured = captureProviderConvertUsage(
      (() => {
        callbackCalls += 1;
        return {};
      }) as never,
      "TestProvider",
      {}
    );
    const usage = {
      first: Promise.reject(new Error("async usage one")),
      second: Promise.reject(new Error("async usage two")),
    };

    expect(() => captured?.(usage as never)).toThrow(
      "convertUsage input must be bounded JSON"
    );
    expect(callbackCalls).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("preserves the receiver and snapshots nested usage", () => {
    const result = {
      inputTokens: {
        cacheRead: 1,
        cacheWrite: 2,
        noCache: 3,
        total: 6,
      },
      outputTokens: { reasoning: 4, text: 5, total: 9 },
      raw: { stable: true },
    };
    const settings = {
      convertUsage(this: unknown) {
        expect(this).toBe(settings);
        return result;
      },
    };
    const captured = captureProviderConvertUsage(
      settings.convertUsage,
      "TestProvider",
      settings
    );
    const snapshot = captured?.({} as never);
    result.inputTokens.total = 999;
    result.raw.stable = false;

    expect(snapshot).toMatchObject({
      inputTokens: { total: 6 },
      raw: { stable: true },
    });
  });

  it("consumes async usage results and nested token siblings", async () => {
    const asyncResult = captureProviderConvertUsage(
      (() => Promise.reject(new Error("async usage result"))) as never,
      "TestProvider",
      {}
    );
    expect(() => asyncResult?.({} as never)).toThrow(
      "convertUsage must return synchronously"
    );

    const nested = captureProviderConvertUsage(
      () =>
        ({
          inputTokens: {
            cacheRead: Promise.reject(new Error("async cache read")),
            cacheWrite: Promise.reject(new Error("async cache write")),
            noCache: 0,
            total: 0,
          },
          outputTokens: {
            reasoning: Promise.reject(new Error("async reasoning tokens")),
            text: 0,
            total: 0,
          },
        }) as never,
      "TestProvider",
      {}
    );
    expect(() => nested?.({} as never)).toThrow(
      "inputTokens fields must be synchronous"
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects invalid numbers without inspecting thenables", () => {
    const invalid = captureProviderConvertUsage(
      () => ({
        inputTokens: {
          cacheRead: 0,
          cacheWrite: 0,
          noCache: 0,
          total: -1,
        },
        outputTokens: { reasoning: 0, text: 0, total: 0 },
      }),
      "TestProvider",
      {}
    );
    expect(() => invalid?.({} as never)).toThrow(
      "inputTokens.total must be a non-negative finite number"
    );

    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then must not be inspected");
      },
    });
    const thenable = captureProviderConvertUsage(
      () => extension as never,
      "TestProvider",
      {}
    );
    expect(() => thenable?.({} as never)).toThrow(
      "convertUsage inputTokens must be an object"
    );
    expect(thenReads).toBe(0);
  });
});

describe("captureProviderFetch", () => {
  it("preserves the settings receiver and genuine Promise result", async () => {
    const settings = {
      fetch(this: unknown) {
        expect(this).toBe(settings);
        return Promise.resolve(new Response("ok"));
      },
    };
    const captured = captureProviderFetch(
      settings.fetch,
      "TestProvider",
      settings
    );

    await expect(captured?.("https://example.test")).resolves.toBeInstanceOf(
      Response
    );
  });

  it("normalizes throws and rejects non-Promise results without probing thenables", async () => {
    const throwing = captureProviderFetch(
      (() => {
        throw new Error("fetch failed");
      }) as never,
      "TestProvider",
      {}
    );
    await expect(throwing?.("https://example.test")).rejects.toThrow(
      "fetch failed"
    );

    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then must not be inspected");
      },
    });
    const thenable = captureProviderFetch(
      (() => extension) as never,
      "TestProvider",
      {}
    );
    await expect(thenable?.("https://example.test")).rejects.toThrow(
      "fetch must return a genuine Promise"
    );
    expect(thenReads).toBe(0);
  });

  it("rejects primitive resolved values while preserving response-like objects", async () => {
    const primitive = captureProviderFetch(
      (() => Promise.resolve(42)) as never,
      "TestProvider",
      {}
    );
    await expect(primitive?.("https://example.test")).rejects.toThrow(
      "fetch must resolve to a response object"
    );

    const responseLike = { body: null, headers: new Headers(), ok: true };
    const compatible = captureProviderFetch(
      (() => Promise.resolve(responseLike)) as never,
      "TestProvider",
      {}
    );
    await expect(compatible?.("https://example.test")).resolves.toBe(
      responseLike
    );
  });
});
