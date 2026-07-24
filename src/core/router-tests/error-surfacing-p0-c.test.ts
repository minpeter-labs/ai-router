import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { asV4, failingModelStatus, genOptions } from "./test-kit";

describe("createRouter — error surfacing (P0-C)", () => {
  it("keeps aggregate summaries stable when observability mutates errors", async () => {
    const first = new Error("first original");
    const last = new Error("last original");
    const route = createRouter({
      models: {
        chat: [
          new MockLanguageModelV4({
            doGenerate: () => Promise.reject(first),
          }),
          new MockLanguageModelV4({
            doGenerate: () => Promise.reject(last),
          }),
        ],
      },
      onError: ({ error }) => {
        if (error instanceof Error) {
          error.message = "mutated by hook";
        }
      },
    });

    let surfaced: unknown;
    try {
      await asV4(route("chat")).doGenerate(genOptions);
    } catch (error) {
      surfaced = error;
    }

    expect(surfaced).toBeInstanceOf(AggregateError);
    expect((surfaced as AggregateError).message).toContain("last original");
    expect((surfaced as AggregateError).message).not.toContain(
      "mutated by hook"
    );
    expect((surfaced as AggregateError).cause).toBe(last);
  });

  it("throws an AggregateError of all candidate errors when several fail", async () => {
    const a = failingModelStatus(503, "first 503");
    const b = failingModelStatus(503, "second 503");
    const c = failingModelStatus(503, "last 503");

    const route = createRouter({
      models: {
        chat: [
          { provider: () => a, model: "a", supports: ["text"] },
          { provider: () => b, model: "b", supports: ["text"] },
          { provider: () => c, model: "c", supports: ["text"] },
        ],
      },
    });

    const err = await asV4(route("chat"))
      .doGenerate(genOptions)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toHaveLength(3);
    expect((err as AggregateError).message).toContain("last 503");
    expect((err as AggregateError).cause).toBe(
      (err as AggregateError).errors.at(-1)
    );
  });

  it("surfaces the ORIGINAL error verbatim for a single failing candidate", async () => {
    const onlyError = Object.assign(new Error("lonely 503"), {
      statusCode: 503,
    });
    const only = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(onlyError),
    });

    const route = createRouter({
      models: {
        chat: [{ provider: () => only, model: "o", supports: ["text"] }],
      },
    });

    await expect(asV4(route("chat")).doGenerate(genOptions)).rejects.toBe(
      onlyError
    );
  });
});
