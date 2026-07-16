import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { okModel } from "./test-kit";

describe("createRouter — lazy instantiation & caching", () => {
  it("consumes and caches rejected async factory results", async () => {
    let factoryCalls = 0;
    const fallback = okModel("fallback");
    const route = createRouter({
      models: {
        chat: [
          {
            model: "async-invalid",
            provider: () => {
              factoryCalls += 1;
              return Promise.reject(new Error("async factory failed")) as never;
            },
          },
          fallback,
        ],
      },
    });

    await generateText({ model: route("chat"), prompt: "one" });
    await generateText({ model: route("chat"), prompt: "two" });
    await Promise.resolve();

    expect(factoryCalls).toBe(1);
    expect(fallback.doGenerateCalls).toHaveLength(2);
  });

  it("ignores arbitrary thenable-like extensions on invalid factory results", async () => {
    let thenReads = 0;
    const thenable = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        if (thenReads > 1) {
          throw new Error("then read twice");
        }
        return (_resolve: unknown, reject: (error: Error) => void) => {
          reject(new Error("unsupported async factory"));
          return Promise.reject(new Error("chained thenable failed"));
        };
      },
    });
    const fallback = okModel("fallback");
    const route = createRouter({
      models: {
        chat: [
          { model: "thenable", provider: () => thenable as never },
          fallback,
        ],
      },
    });

    await generateText({ model: route("chat"), prompt: "one" });
    await generateText({ model: route("chat"), prompt: "two" });

    expect(thenReads).toBe(0);
    expect(fallback.doGenerateCalls).toHaveLength(2);
  });

  it("does not read alternate-shape extension getters", async () => {
    const wrapperModel = okModel("wrapped");
    const wrapper = Object.defineProperties(
      {
        model: "wrapped-id",
        provider: () => wrapperModel,
      },
      {
        specificationVersion: {
          get() {
            throw new Error("wrapper specification extension must not be read");
          },
        },
        [["th", "en"].join("")]: {
          get() {
            throw new Error("wrapper then extension must not be read");
          },
        },
      }
    );
    const bare = okModel("bare");
    Object.defineProperty(bare, ["th", "en"].join(""), {
      get() {
        throw new Error("bare then extension must not be read");
      },
    });
    const route = createRouter({
      models: { bare: [bare], wrapped: [wrapper as never] },
    });

    await expect(
      generateText({ model: route("wrapped"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "wrapped" });
    await expect(
      generateText({ model: route("bare"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "bare" });
  });
});
