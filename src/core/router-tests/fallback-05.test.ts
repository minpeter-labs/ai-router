import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import { asV4, finishReason, genOptions, okModel, usage } from "./test-kit";

describe("createRouter — fallback", () => {
  it("falls back when generate content properties throw", async () => {
    const hostile = Object.defineProperty(
      { finishReason, usage, warnings: [] },
      "content",
      {
        get() {
          throw new Error("content getter failed");
        },
      }
    );
    const route = createRouter({
      models: {
        chat: [
          new MockLanguageModelV4({
            doGenerate: () => Promise.resolve(hostile as never),
          }),
          okModel("valid"),
        ],
      },
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "valid" }],
    });
  });

  it("reads generate envelope accessors once and snapshots result arrays", async () => {
    const content = [{ text: "stable", type: "text" as const }];
    const warnings = [{ message: "note", type: "other" as const }];
    const values = {
      content,
      finishReason,
      providerMetadata: { mock: { stable: true } },
      request: { body: "request" },
      response: { id: "response" },
      usage,
      warnings,
    };
    const reads = new Map<string, number>();
    const source = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          {
            enumerable: true,
            get() {
              const count = (reads.get(key) ?? 0) + 1;
              reads.set(key, count);
              if (count > 1) {
                throw new Error(`${key} read twice`);
              }
              return value;
            },
          },
        ])
      )
    );
    const primary = new MockLanguageModelV4({
      doGenerate: async () => source as never,
    });
    const route = createRouter({ models: { chat: [primary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);
    content.length = 0;
    warnings.length = 0;

    expect(Object.fromEntries(reads)).toEqual(
      Object.fromEntries(Object.keys(values).map((key) => [key, 1]))
    );
    expect(result.content).toEqual([{ text: "stable", type: "text" }]);
    expect(result.warnings).toEqual([{ message: "note", type: "other" }]);
  });

  it("snapshots nested finish and usage accessors once", async () => {
    const reads = new Map<string, number>();
    const once = (scope: string, values: Record<string, unknown>) =>
      Object.defineProperties(
        {},
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            {
              enumerable: true,
              get() {
                const label = `${scope}.${key}`;
                const count = (reads.get(label) ?? 0) + 1;
                reads.set(label, count);
                if (count > 1) {
                  throw new Error(`${label} read twice`);
                }
                return value;
              },
            },
          ])
        )
      );
    const inputTokens = once("input", usage.inputTokens);
    const outputTokens = once("output", usage.outputTokens);
    const nestedUsage = once("usage", {
      inputTokens,
      outputTokens,
      raw: { provider: "stable" },
    });
    const nestedFinish = once("finish", finishReason);
    const primary = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [{ text: "stable", type: "text" }],
          finishReason: nestedFinish,
          usage: nestedUsage,
          warnings: [],
        }) as never,
    });
    const route = createRouter({ models: { chat: [primary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);

    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(result.finishReason).toEqual(finishReason);
    expect(result.usage).toEqual({ ...usage, raw: { provider: "stable" } });
  });

  it("snapshots nested request, response, and header accessors once", async () => {
    const reads = new Map<string, number>();
    const getter = (name: string, read: () => unknown) => ({
      enumerable: true,
      get() {
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        if (count > 1) {
          throw new Error(`${name} read twice`);
        }
        return read();
      },
    });
    let headerValue = "stable";
    const headers = Object.create(null);
    Object.defineProperty(
      headers,
      "__proto__",
      getter("header.__proto__", () => "literal")
    );
    Object.defineProperty(
      headers,
      "x-provider",
      getter("header.x-provider", () => headerValue)
    );
    const requestBody = { prompt: "request-body" };
    const responseBody = { id: "response-body" };
    const request = Object.defineProperties(
      {},
      {
        body: getter("request.body", () => requestBody),
      }
    );
    const timestamp = new Date(1000);
    const response = Object.defineProperties(
      {},
      {
        body: getter("response.body", () => responseBody),
        headers: getter("response.headers", () => headers),
        id: getter("response.id", () => "response-id"),
        modelId: getter("response.modelId", () => "provider-model"),
        timestamp: getter("response.timestamp", () => timestamp),
      }
    );
    const primary = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ text: "stable", type: "text" }],
        finishReason,
        request,
        response,
        usage,
        warnings: [],
      }),
    });
    const route = createRouter({ models: { chat: [primary] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);
    headerValue = "mutated";
    requestBody.prompt = "mutated";
    responseBody.id = "mutated";
    timestamp.setTime(2000);

    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(result.request).toEqual({ body: { prompt: "request-body" } });
    expect(result.response).toMatchObject({
      body: { id: "response-body" },
      id: "response-id",
      modelId: "provider-model",
      timestamp: new Date(1000),
    });
    expect(result.response?.timestamp).not.toBe(timestamp);
    const copiedHeaders = result.response?.headers as Record<string, string>;
    expect(copiedHeaders["x-provider"]).toBe("stable");
    expect(Reflect.get(copiedHeaders, "__proto__")).toBe("literal");
    expect(Object.getPrototypeOf(copiedHeaders)).toBe(Object.prototype);
  });

  it("preserves opaque request and response telemetry bodies", async () => {
    const requestBody = new FormData();
    requestBody.set("prompt", "hello");
    const responseBody = new Uint8Array([1, 2, 3]);
    const fallback = okModel("must not run");
    const primary = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ text: "stable", type: "text" }],
        finishReason,
        request: { body: requestBody },
        response: { body: responseBody },
        usage,
        warnings: [],
      }),
    });
    const route = createRouter({ models: { chat: [primary, fallback] } });

    const result = await asV4(route("chat")).doGenerate(genOptions);

    expect(result.request?.body).toBe(requestBody);
    expect(result.response?.body).toBe(responseBody);
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });
});
