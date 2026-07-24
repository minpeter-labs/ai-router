import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import type { OnRouterAttempt } from "../types";
import {
  asV4,
  collectRawStream,
  genOptions,
  okModel,
  streamingModel,
} from "./test-kit";

const PROVIDER_NOT_FOUND_MESSAGE =
  "The provider 'infercom-k01' is not configured for model 'deepseek-ai/deepseek-v3.1'.";

function providerNotFoundError(): Error {
  return Object.assign(new Error(PROVIDER_NOT_FOUND_MESSAGE), {
    responseBody: JSON.stringify({
      error: {
        code: "provider_not_found",
        message: PROVIDER_NOT_FOUND_MESSAGE,
        param: "provider.gateway.only",
        type: "invalid_request_error",
      },
    }),
    statusCode: 404,
  });
}

describe("createRouter — provider_not_found fallback", () => {
  it("falls through a provider_not_found generate failure", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(providerNotFoundError()),
    });
    const secondary = okModel("generated fallback");
    const attempts: Parameters<OnRouterAttempt>[0][] = [];
    const route = createRouter({
      models: { chat: [primary, secondary] },
      onAttempt: (event) => attempts.push(event),
    });

    await expect(
      asV4(route("chat")).doGenerate(genOptions)
    ).resolves.toMatchObject({
      content: [{ text: "generated fallback", type: "text" }],
    });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(secondary.doGenerateCalls).toHaveLength(1);
    expect(attempts).toMatchObject([
      {
        failure: { retryable: true, scope: "routing-unit", statusCode: 404 },
        index: 0,
        outcome: "failure",
        phase: "generate",
        willRetry: true,
      },
      { index: 1, outcome: "success", phase: "generate" },
    ]);
  });

  it("falls through a provider_not_found stream-open failure", async () => {
    const primary = new MockLanguageModelV4({
      doStream: () => Promise.reject(providerNotFoundError()),
    });
    const secondary = streamingModel(["streamed fallback"]);
    const attempts: Parameters<OnRouterAttempt>[0][] = [];
    const route = createRouter({
      models: { chat: [primary, secondary] },
      onAttempt: (event) => attempts.push(event),
    });

    const result = await asV4(route("chat")).doStream(genOptions);
    await expect(collectRawStream(result.stream)).resolves.toEqual({
      text: "streamed fallback",
    });
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(attempts).toMatchObject([
      {
        failure: { retryable: true, scope: "routing-unit", statusCode: 404 },
        index: 0,
        outcome: "failure",
        phase: "stream-open",
        willRetry: true,
      },
      { index: 1, outcome: "success", phase: "stream-mid" },
    ]);
  });
});
