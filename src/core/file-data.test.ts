import { describe, expect, it } from "vitest";
import { AsyncFilePayloadError, snapshotFileData } from "./file-data";

describe("snapshotFileData", () => {
  it("copies bytes without consulting iterator or species extensions", () => {
    let extensionReads = 0;
    const bytes = new Uint8Array([1, 2, 3]);
    Object.defineProperties(bytes, {
      constructor: {
        get() {
          extensionReads += 1;
          throw new Error("constructor extension must not run");
        },
      },
      [Symbol.iterator]: {
        get() {
          extensionReads += 1;
          throw new Error("iterator extension must not run");
        },
      },
      [Symbol.toStringTag]: {
        get() {
          extensionReads += 1;
          throw new Error("toStringTag extension must not run");
        },
      },
    });

    const result = snapshotFileData(
      { data: bytes, type: "data" },
      { remainingFileBytes: 3 }
    ) as { data: Uint8Array };

    bytes[0] = 9;
    expect(extensionReads).toBe(0);
    expect(result.data === bytes).toBe(false);
    expect([...result.data]).toEqual([1, 2, 3]);
  });

  it("copies URLs without consulting instance string extensions", () => {
    let extensionReads = 0;
    const url = new URL("https://example.com/file.png");
    Object.defineProperty(url, "toString", {
      get() {
        extensionReads += 1;
        throw new Error("URL string extension must not run");
      },
    });

    const result = snapshotFileData(
      { type: "url", url },
      { remainingFileBytes: 1024 }
    ) as { url: URL };

    url.pathname = "/mutated.png";
    expect(extensionReads).toBe(0);
    expect(result.url).not.toBe(url);
    expect(URL.prototype.toString.call(result.url)).toBe(
      "https://example.com/file.png"
    );
  });

  it("enforces the aggregate payload budget before copying", () => {
    expect(() =>
      snapshotFileData(
        { data: new Uint8Array([1, 2, 3]), type: "data" },
        { remainingFileBytes: 2 }
      )
    ).toThrow("file payloads exceed");
  });

  it("consumes rejected native Promise payloads without reading thenables", async () => {
    const rejected = Promise.reject(new Error("async file payload"));
    expect(() =>
      snapshotFileData(
        { data: rejected, type: "data" },
        { remainingFileBytes: 1024 }
      )
    ).toThrow(AsyncFilePayloadError);
    expect(() =>
      snapshotFileData(
        {
          data: Promise.reject(new Error("async sibling file data")),
          type: Promise.reject(new Error("async file discriminant")),
        },
        { remainingFileBytes: 1024 }
      )
    ).toThrow(AsyncFilePayloadError);

    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then extension must not run");
      },
    });
    expect(
      snapshotFileData(
        { data: thenable, type: "data" },
        { remainingFileBytes: 1024 }
      )
    ).toEqual({ data: thenable, type: "data" });
    expect(thenReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes payload Promise siblings before ordinary getters fail", async () => {
    const discriminantFailure = Object.defineProperties(
      {},
      {
        data: {
          value: Promise.reject(new Error("async data sibling")),
        },
        type: {
          get() {
            throw new Error("type getter failed");
          },
        },
        url: {
          value: Promise.reject(new Error("async URL sibling")),
        },
      }
    );
    const payloadFailure = Object.defineProperties(
      {},
      {
        data: {
          get() {
            throw new Error("data getter failed");
          },
        },
        type: { value: "data" },
        url: {
          value: Promise.reject(new Error("inactive URL sibling")),
        },
      }
    );

    expect(() =>
      snapshotFileData(discriminantFailure, { remainingFileBytes: 1024 })
    ).toThrow("type getter failed");
    expect(() =>
      snapshotFileData(payloadFailure, { remainingFileBytes: 1024 })
    ).toThrow("data getter failed");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not invoke inactive payload accessors", () => {
    let inactiveReads = 0;
    const urlPayload = Object.defineProperty(
      { type: "url", url: new URL("https://example.test/file") },
      "data",
      {
        get() {
          inactiveReads += 1;
          throw new Error("inactive data accessor must not run");
        },
      }
    );

    expect(
      snapshotFileData(urlPayload, { remainingFileBytes: 1024 })
    ).toMatchObject({ type: "url" });
    expect(inactiveReads).toBe(0);
  });
});
