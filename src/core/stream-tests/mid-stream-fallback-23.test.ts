import { describe, expect, it } from "vitest";
import {
  chunkModel,
  finishReason,
  lazyChunkModel,
  runFallback,
  textModel,
  usage,
} from "./test-kit";

describe("createFallbackStream (mid-stream fallback)", () => {
  it("consumes source Promise siblings before ordinary discriminant getters fail", async () => {
    const rejectedHandled = (message: string) => {
      const promise = Promise.reject(new Error(message));
      promise.catch(() => undefined);
      return promise;
    };
    const source = Object.defineProperties(
      { type: "source" },
      {
        filename: {
          value: rejectedHandled("async filename sibling"),
        },
        sourceType: {
          get() {
            throw new Error("source discriminant failed");
          },
        },
        url: {
          value: rejectedHandled("async URL sibling"),
        },
      }
    ) as never;
    const malformed = chunkModel([
      { type: "stream-start", warnings: [] },
      source,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes active stream-field Promise siblings before a getter fails", async () => {
    const metadata = Promise.reject(new Error("async source metadata sibling"));
    metadata.catch(() => undefined);
    const source = Object.defineProperties(
      { sourceType: "url", type: "source" },
      {
        id: {
          get() {
            throw new Error("source id failed");
          },
        },
        providerMetadata: {
          value: metadata,
        },
        url: { value: "https://example.test/source" },
      }
    ) as never;
    const malformed = chunkModel([
      { type: "stream-start", warnings: [] },
      source,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects non-string stream discriminants without coercion", async () => {
    let coercions = 0;
    const hostile = {
      toString() {
        coercions += 1;
        return "text-delta";
      },
    };
    for (const malformed of [
      chunkModel([
        { type: "stream-start", warnings: [] },
        { delta: "bad", id: "1", type: hostile } as never,
      ]),
      chunkModel([
        {
          type: "stream-start",
          warnings: [{ message: "bad", type: hostile }],
        } as never,
      ]),
      chunkModel([
        { type: "stream-start", warnings: [] },
        {
          finishReason: { raw: "stop", unified: hostile },
          type: "finish",
          usage,
        } as never,
      ]),
    ]) {
      const out = await runFallback([malformed, textModel(["recovered"])]);
      expect(out.error).toBeUndefined();
      expect(out.text).toBe("recovered");
    }
    expect(coercions).toBe(0);
  });

  it("rejects unknown stream file tags without reading payload fields", async () => {
    let reads = 0;
    const data = Object.defineProperties(
      {},
      {
        type: { enumerable: true, value: "unknown" },
        url: {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error("unknown payload must not be read");
          },
        },
      }
    );
    const malformed = chunkModel([
      { type: "stream-start", warnings: [] },
      { data, mediaType: "image/png", type: "file" } as never,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    expect(reads).toBe(0);
  });

  it("consumes rejected nested streamed file payloads before fallback", async () => {
    const malformed = lazyChunkModel([
      () => ({ type: "stream-start", warnings: [] }),
      () =>
        ({
          data: {
            data: Promise.reject(new Error("async streamed file data")),
            type: "data",
          },
          mediaType: "image/png",
          type: "file",
        }) as never,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes own Promise siblings after an async stream discriminant", async () => {
    const malformed = lazyChunkModel([
      () => ({ type: "stream-start", warnings: [] }),
      () =>
        ({
          data: Promise.reject(new Error("async stream data sibling")),
          mediaType: Promise.reject(
            new Error("async stream media type sibling")
          ),
          providerMetadata: Promise.reject(
            new Error("async stream metadata sibling")
          ),
          type: Promise.reject(new Error("async stream discriminant")),
        }) as never,
    ]);

    const out = await runFallback([malformed, textModel(["recovered"])]);

    expect(out.error).toBeUndefined();
    expect(out.text).toBe("recovered");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots mutable streamed byte and URL payloads", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const url = new URL("https://example.com/file.png");
    const model = chunkModel([
      { type: "stream-start", warnings: [] },
      {
        data: { data: bytes, type: "data" },
        mediaType: "image/png",
        type: "file",
      } as never,
      {
        data: { type: "url", url },
        mediaType: "image/png",
        type: "file",
      } as never,
      { type: "finish", finishReason, usage },
    ]);

    const out = await runFallback([model]);
    const files = out.parts.filter(
      (part) => part.type === "file"
    ) as unknown as Array<{
      data: { data?: Uint8Array; url?: URL };
    }>;
    bytes[0] = 9;
    url.pathname = "/mutated.png";

    expect(out.error).toBeUndefined();
    expect(files[0].data.data).not.toBe(bytes);
    expect([...(files[0].data.data ?? [])]).toEqual([1, 2, 3]);
    expect(files[1].data.url).not.toBe(url);
    expect(files[1].data.url?.toString()).toBe("https://example.com/file.png");
  });
});
