import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import { asV4, EXAMPLE_HTTPS_RE, okModel } from "./test-kit";

describe("createRouter — supportedUrls", () => {
  it("accepts cross-realm RegExp patterns and reads array indexes once", () => {
    const crossRealm = runInNewContext(
      "new RegExp('^https://example\\\\.com/', 'gi')"
    ) as RegExp;
    let reads = 0;
    const patterns = new Proxy([crossRealm], {
      get(target, property, receiver) {
        if (property === "0") {
          reads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const model = okModel();
    Object.defineProperty(model, "supportedUrls", {
      value: { "image/*": patterns },
    });
    const route = createRouter({ models: { chat: [model] } });

    const supported = asV4(route("chat")).supportedUrls as Record<
      string,
      RegExp[]
    >;

    expect(reads).toBe(1);
    expect(supported["image/*"][0]).not.toBe(crossRealm);
    expect(supported["image/*"][0]).toMatchObject({
      flags: "gi",
      lastIndex: 0,
      source: crossRealm.source,
    });
  });

  it("copies special supportedUrls keys without prototype mutation", () => {
    const urls = Object.create(null);
    Object.defineProperty(urls, "__proto__", {
      enumerable: true,
      value: [EXAMPLE_HTTPS_RE],
    });
    const model = okModel();
    Object.defineProperty(model, "supportedUrls", { value: urls });
    const route = createRouter({ models: { chat: [model] } });

    const supported = asV4(route("chat")).supportedUrls as Record<
      string,
      RegExp[]
    >;

    expect(Object.getPrototypeOf(supported)).toBe(Object.prototype);
    expect(Object.hasOwn(supported, "__proto__")).toBe(true);
    expect(Reflect.get(supported, "__proto__")).toHaveLength(1);
  });

  it("fails closed on excessive supportedUrls pattern totals and source size", () => {
    const excessiveCount = okModel();
    Object.defineProperty(excessiveCount, "supportedUrls", {
      value: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          `type/${index}`,
          Array.from({ length: 128 }, () => EXAMPLE_HTTPS_RE),
        ])
      ),
    });
    const excessiveSource = okModel();
    Object.defineProperty(excessiveSource, "supportedUrls", {
      value: { "image/*": [new RegExp("a".repeat(4097))] },
    });

    expect(
      asV4(createRouter({ models: { chat: [excessiveCount] } })("chat"))
        .supportedUrls
    ).toEqual({});
    expect(
      asV4(createRouter({ models: { chat: [excessiveSource] } })("chat"))
        .supportedUrls
    ).toEqual({});
  });

  it("fails closed without reading supportedUrls thenable extensions", () => {
    let reads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("then extension must not run");
      },
    });
    const model = okModel();
    Object.defineProperty(model, "supportedUrls", { value: thenable });
    const route = createRouter({ models: { chat: [model] } });

    expect(asV4(route("chat")).supportedUrls).toEqual({});
    expect(reads).toBe(0);
  });

  it("settles async supportedUrls when timer cleanup throws", async () => {
    const clear = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => {
        throw new Error("timer cleanup unavailable");
      });
    try {
      const model = okModel();
      Object.defineProperty(model, "supportedUrls", {
        value: Promise.resolve({ "image/*": [EXAMPLE_HTTPS_RE] }),
      });
      const routed = asV4(createRouter({ models: { chat: [model] } })("chat"));

      await expect(routed.supportedUrls).resolves.toEqual({
        "image/*": [EXAMPLE_HTTPS_RE],
      });
    } finally {
      clear.mockRestore();
    }
  });

  it("fails open when supportedUrls timer registration is unavailable", async () => {
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(
        () => Promise.reject(new Error("async capability timer")) as never
      );
    try {
      const model = okModel();
      Object.defineProperty(model, "supportedUrls", {
        value: Promise.resolve({ "image/*": [EXAMPLE_HTTPS_RE] }),
      });
      const routed = asV4(createRouter({ models: { chat: [model] } })("chat"));

      await expect(routed.supportedUrls).resolves.toEqual({});
      await Promise.resolve();
    } finally {
      timer.mockRestore();
    }
  });

  it("fails closed when async supportedUrls discovery never settles", async () => {
    vi.useFakeTimers();
    try {
      let resolveLookup: ((value: unknown) => void) | undefined;
      const model = okModel("still usable");
      const pending = new Promise<unknown>((resolve) => {
        resolveLookup = resolve;
      });
      Object.defineProperty(model, "supportedUrls", {
        value: pending,
      });
      const route = createRouter({ models: { chat: [model] } });
      const discovery = asV4(route("chat")).supportedUrls;

      await vi.advanceTimersByTimeAsync(1000);
      await expect(discovery).resolves.toEqual({});

      resolveLookup?.({ "image/*": [EXAMPLE_HTTPS_RE] });
      await expect(discovery).resolves.toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});
