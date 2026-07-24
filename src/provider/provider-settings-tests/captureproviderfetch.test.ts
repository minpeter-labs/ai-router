import { describe, expect, it } from "vitest";
import { captureProviderFetch } from "../provider-settings-fetch";

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
