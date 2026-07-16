import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { okModel } from "./test-kit";

describe("createRouter — configuration errors", () => {
  it('throws "unknown model id" for an unregistered logical id', () => {
    const route = createRouter({ models: {} });
    expect(() => route("nope")).toThrow("unknown model id");
  });

  it("throws when a logical id maps to an empty candidate list", () => {
    expect(() => createRouter({ models: { chat: [] } })).toThrow(
      "no provider entries"
    );
  });

  it("rejects malformed router and model containers eagerly", () => {
    expect(() => createRouter(null as never)).toThrow(
      "createRouter options must be an object"
    );
    expect(() => createRouter({ models: null } as never)).toThrow(
      "models must be an object"
    );
    expect(() => createRouter({ models: { chat: {} } } as never)).toThrow(
      "must map to a provider entry array"
    );
    expect(() => createRouter({ models: { chat: [null] } } as never)).toThrow(
      "each provider entry must be an object"
    );
  });

  it("bounds logical route ids, route count, and aggregate candidates", () => {
    const candidate = { model: okModel() };
    expect(() => createRouter({ models: { "": [candidate] } })).toThrow(
      "model ids must be non-empty"
    );
    expect(() =>
      createRouter({ models: { ["x".repeat(257)]: [candidate] } })
    ).toThrow("at most 256 characters");

    const routes = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [
        `route-${index}`,
        [candidate],
      ])
    );
    expect(() => createRouter({ models: routes })).toThrow(
      "at most 10000 logical routes"
    );

    let routeReads = 0;
    const guardedRoutes = new Proxy(routes, {
      get(target, key, receiver) {
        routeReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => createRouter({ models: guardedRoutes })).toThrow(
      "at most 10000 logical routes"
    );
    expect(routeReads).toBe(0);

    const candidates = Array.from({ length: 10_000 }, () => candidate);
    const excessive = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`route-${index}`, candidates])
    );
    expect(() => createRouter({ models: excessive })).toThrow(
      "exceed 100000 total candidates"
    );
  });

  it("reads each configured route value exactly once", () => {
    let reads = 0;
    const models = Object.defineProperty({}, "chat", {
      enumerable: true,
      get() {
        reads += 1;
        return [{ model: okModel() }];
      },
    });

    const route = createRouter({ models } as never);

    expect(reads).toBe(1);
    expect(route("chat")).toBeDefined();
  });

  it("validates shared admission conflicts across logical models eagerly", () => {
    expect(() =>
      createRouter({
        models: {
          first: [{ model: okModel(), healthKey: "shared", maxConcurrency: 1 }],
          second: [
            { model: okModel(), healthKey: "shared", maxConcurrency: 2 },
          ],
        },
      })
    ).toThrow("must use identical concurrency settings");
  });

  it("does not treat inherited object properties as configured model ids", () => {
    const route = createRouter({ models: {} });
    expect(() => route("toString")).toThrow("unknown model id");
  });

  it("validates factory entry shape eagerly without invoking valid factories", () => {
    expect(() =>
      createRouter({
        models: { chat: [{ model: "missing-provider" } as never] },
      })
    ).toThrow("requires a `provider` function");

    let calls = 0;
    createRouter({
      models: {
        chat: [
          {
            model: "valid",
            provider: () => {
              calls += 1;
              return okModel();
            },
          },
        ],
      },
    });
    expect(calls).toBe(0);
  });

  it("snapshots accessor-backed factory fields exactly once", async () => {
    let modelReads = 0;
    let providerReads = 0;
    const model = okModel("accessor snapshot");
    const entry = Object.defineProperties(
      {},
      {
        model: {
          enumerable: true,
          get() {
            modelReads += 1;
            if (modelReads > 1) {
              throw new Error("model read twice");
            }
            return "model-id";
          },
        },
        provider: {
          enumerable: true,
          get() {
            providerReads += 1;
            if (providerReads > 1) {
              throw new Error("provider read twice");
            }
            return function (this: unknown) {
              expect(this).toBe(entry);
              return model;
            };
          },
        },
      }
    );

    const route = createRouter({ models: { chat: [entry as never] } });
    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "accessor snapshot" });
    expect({ modelReads, providerReads }).toEqual({
      modelReads: 1,
      providerReads: 1,
    });
  });
});
