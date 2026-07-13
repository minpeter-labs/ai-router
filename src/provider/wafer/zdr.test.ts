import { describe, expect, it } from "vitest";
import { createZdrFetch } from "./zdr";

describe("createZdrFetch", () => {
  it("captures RequestInit fields and enforces the ZDR header", async () => {
    let captured: RequestInit | undefined;
    const wrapped = createZdrFetch((_input, init) => {
      captured = init;
      return Promise.resolve(new Response());
    });
    const init = {
      headers: { "Wafer-ZDR": "optional", "x-custom": "stable" },
      method: "POST",
    };

    await wrapped("https://example.test", init);
    init.method = "GET";

    expect(captured?.method).toBe("POST");
    const headers = new Headers(captured?.headers);
    expect(headers.get("wafer-zdr")).toBe("required");
    expect(headers.get("x-custom")).toBe("stable");
  });

  it("consumes RequestInit and header Promise siblings before rejection", async () => {
    const wrapped = createZdrFetch(() => Promise.resolve(new Response()));
    const init = Object.defineProperties(
      {
        body: Promise.reject(new Error("async body")),
        headers: {
          first: Promise.reject(new Error("async header first")),
          second: Promise.reject(new Error("async header second")),
        },
      },
      {
        method: {
          get() {
            throw new Error("method accessor failed");
          },
        },
      }
    );

    expect(() => wrapped("https://example.test", init as never)).toThrow(
      "method accessor failed"
    );
    expect(() =>
      wrapped("https://example.test", {
        headers: [
          [
            Promise.reject(new Error("async header name")),
            Promise.reject(new Error("async header value")),
          ],
        ] as never,
      })
    ).toThrow("Wafer header values must be synchronous");
    expect(() =>
      wrapped(
        Promise.reject(new Error("async fetch input")) as never,
        undefined
      )
    ).toThrow("Wafer fetch input must be synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not inspect arbitrary thenable header extensions", async () => {
    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then must not be inspected");
      },
    });
    let captured: RequestInit | undefined;
    const wrapped = createZdrFetch((_input, init) => {
      captured = init;
      return Promise.resolve(new Response());
    });

    await wrapped("https://example.test", {
      headers: { extension: extension as never },
    });
    expect(new Headers(captured?.headers).get("extension")).toBe(
      "[object Object]"
    );
    expect(thenReads).toBe(0);
  });

  it("requires a genuine Promise from the wrapped fetch", async () => {
    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then must not be inspected");
      },
    });
    const wrapped = createZdrFetch((() => extension) as never);

    await expect(wrapped("https://example.test")).rejects.toThrow(
      "Wafer fetch must return a genuine Promise"
    );
    expect(thenReads).toBe(0);
  });
});
