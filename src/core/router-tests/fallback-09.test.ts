import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { asV4, finishReason, genOptions, okModel, usage } from "./test-kit";

describe("createRouter — fallback", () => {
  it("consumes rejected nested mutations on discarded validator input", async () => {
    const route = createRouter({
      fallback: {
        validateResult: (result) => {
          const content = result.content[0] as unknown as Record<
            string,
            unknown
          >;
          content.text = Promise.reject(new Error("async content text"));
          content.type = Promise.reject(new Error("async content type"));
          const finish = result.finishReason as unknown as Record<
            string,
            unknown
          >;
          finish.raw = Promise.reject(new Error("async finish raw"));
          finish.unified = Promise.reject(new Error("async finish unified"));
          result.warnings.push({
            message: Promise.reject(new Error("async warning message")),
            type: Promise.reject(new Error("async warning type")),
          } as never);
          const mutable = result as unknown as Record<string, unknown>;
          mutable.request = {
            body: Promise.reject(new Error("async request body")),
          };
          mutable.response = {
            id: Promise.reject(new Error("async response id")),
            timestamp: Promise.reject(new Error("async response timestamp")),
          };
          const usage = result.usage as unknown as Record<string, unknown>;
          usage.raw = Promise.reject(new Error("async usage raw"));
          const input = usage.inputTokens as Record<string, unknown>;
          input.total = Promise.reject(new Error("async input total"));
          const output = usage.outputTokens as Record<string, unknown>;
          output.total = Promise.reject(new Error("async output total"));
          return true;
        },
      },
      models: { chat: [okModel("stable")] },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "stable" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes rejected mutations on pre-captured validator JSON fields", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            providerMetadata: { mock: { nested: { value: "content" } } },
            text: "stable",
            type: "text" as const,
          },
        ],
        finishReason,
        providerMetadata: { mock: { nested: { value: "root" } } },
        response: { body: { nested: { value: "response" } } },
        usage: { ...usage, raw: { nested: { value: "usage" } } },
        warnings: [],
      }),
    });
    const route = createRouter({
      fallback: {
        validateResult: (result) => {
          const root = result.providerMetadata?.mock as {
            nested: { value: unknown };
          };
          root.nested.value = Promise.reject(new Error("async root JSON"));
          const part = result.content[0] as unknown as {
            providerMetadata: { mock: { nested: { value: unknown } } };
          };
          part.providerMetadata.mock.nested.value = Promise.reject(
            new Error("async content JSON")
          );
          const responseBody = result.response?.body as {
            nested: { value: unknown };
          };
          responseBody.nested.value = Promise.reject(
            new Error("async response JSON")
          );
          const raw = result.usage.raw as { nested: { value: unknown } };
          raw.nested.value = Promise.reject(new Error("async usage JSON"));
          return true;
        },
      },
      models: { chat: [model] },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "stable" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("treats malformed or throwing validateResult hooks as terminal request errors", async () => {
    for (const validateResult of [
      (() => undefined) as never,
      (() => Promise.resolve(true)) as never,
      (() => Promise.reject(new Error("async validator rejected"))) as never,
      (() => {
        throw new Error("validator bug");
      }) as never,
    ]) {
      const secondary = okModel("must not run");
      const route = createRouter({
        fallback: { validateResult },
        models: { chat: [okModel("primary"), secondary] },
      });

      await expect(
        asV4(route("chat")).doGenerate(genOptions)
      ).rejects.toMatchObject({
        code: "validator_contract_error",
      });
      expect(secondary.doGenerateCalls).toHaveLength(0);
    }

    let thenReads = 0;
    const thenExtendedResult = Object.defineProperty(
      {},
      ["th", "en"].join(""),
      {
        get() {
          thenReads += 1;
          throw new Error("arbitrary then getter must not be read");
        },
      }
    );
    const route = createRouter({
      fallback: { validateResult: (() => thenExtendedResult) as never },
      models: { chat: [okModel("primary"), okModel("must not run")] },
    });
    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).rejects.toMatchObject({ code: "validator_contract_error" });
    expect(thenReads).toBe(0);
  });

  it("does not train provider state or fan out after a validator contract throw", async () => {
    let validations = 0;
    const primary = okModel("valid provider result");
    const fallback = okModel("must not run");
    const route = createRouter({
      fallback: {
        health: true,
        retryBudget: true,
        validateResult: () => {
          validations += 1;
          if (validations === 1) {
            return true;
          }
          throw new Error("validator implementation failed");
        },
      },
      models: {
        chat: [
          {
            adaptiveConcurrency: {
              increaseAfterSuccesses: 2,
              initial: 2,
              max: 4,
              min: 1,
            },
            model: primary,
          },
          fallback,
        ],
      },
    });

    await expect(
      generateText({ model: route("chat"), prompt: "valid" })
    ).resolves.toMatchObject({
      text: "valid provider result",
    });
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      inFlight: 0,
      successes: 1,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });

    await expect(
      generateText({ model: route("chat"), prompt: "broken validator" })
    ).rejects.toMatchObject({
      code: "validator_contract_error",
    });
    expect(fallback.doGenerateCalls).toHaveLength(0);
    expect(route.getHealthSnapshot("chat")).toEqual([]);
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      inFlight: 0,
      limit: 2,
      successes: 1,
    });
    expect(route.getRetryBudgetSnapshot("chat")[0]).toMatchObject({
      failures: 0,
      samples: 1,
    });
  });
});
