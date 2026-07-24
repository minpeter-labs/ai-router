import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { captureFetch } from "../test-utils";
import { createFriendli } from "./friendli";

describe("createFriendli", () => {
  it("consumes Promise-valued provider settings and header siblings", async () => {
    expect(() =>
      createFriendli(Promise.reject(new Error("async settings")) as never)
    ).toThrow("Friendli settings must be synchronous");
    expect(() =>
      createFriendli({
        apiKey: Promise.reject(new Error("async api key")) as never,
        fetch: Promise.reject(new Error("async fetch")) as never,
      })
    ).toThrow("Friendli settings must be synchronous");
    expect(() =>
      createFriendli({
        headers: {
          first: Promise.reject(new Error("async header one")),
          second: Promise.reject(new Error("async header two")),
        } as never,
      })
    ).toThrow("Friendli header values must be synchronous");
    expect(() =>
      createFriendli({
        queryParams: {
          first: Promise.reject(new Error("async query first")),
          second: Promise.reject(new Error("async query second")),
        } as never,
      })
    ).toThrow("Friendli query parameter values must be synchronous");
    const friendli = createFriendli({ apiKey: "k" });
    expect(() =>
      friendli(Promise.reject(new Error("async model id")) as never)
    ).toThrow("Friendli modelId must be a synchronous non-empty string");
    expect(() => friendli("")).toThrow(
      "Friendli modelId must be a synchronous non-empty string"
    );
    expect(() => createFriendli({ apiKey: 42 as never })).toThrow(
      "Friendli apiKey must be a non-empty bounded string"
    );
    expect(() => createFriendli({ fetch: {} as never })).toThrow(
      "Friendli fetch must be a function"
    );
    let invalidReads = 0;
    const invalidHeaders = Object.defineProperties(
      {},
      {
        "bad header": {
          enumerable: true,
          get() {
            invalidReads += 1;
            throw new Error("invalid header value must not be read");
          },
        },
        later: {
          enumerable: true,
          value: Promise.reject(new Error("async invalid-name sibling")),
        },
      }
    );
    expect(() => createFriendli({ headers: invalidHeaders as never })).toThrow(
      "Friendli header names must use valid HTTP syntax"
    );
    expect(invalidReads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots query parameters before requests", async () => {
    const { fetch, captured } = captureFetch();
    const queryParams = { region: "stable" };
    const friendli = createFriendli({ apiKey: "k", fetch, queryParams });
    queryParams.region = "mutated";

    await generateText({ model: friendli("m"), prompt: "hi" });
    expect(captured.url).toContain("region=stable");
    expect(captured.url).not.toContain("mutated");
  });

  it("returns a callable provider that builds a language model object", () => {
    const friendli = createFriendli({ apiKey: "k" });
    expect(typeof friendli).toBe("function");

    const model = friendli("m");
    expect(model.specificationVersion).toBe("v4");
    expect(typeof model.doGenerate).toBe("function");
    expect(typeof model.doStream).toBe("function");
    expect(model.modelId).toBe("m");
    expect(model.provider).toBe("friendli.chat");
  });

  it("uses the friendli serverless base URL by default", async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({ apiKey: "k", fetch });

    await generateText({ model: friendli("m"), prompt: "hi" });

    expect(captured.url).toBe(
      "https://api.friendli.ai/serverless/v1/chat/completions"
    );
  });

  it("respects a baseURL override", async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({
      apiKey: "k",
      fetch,
      baseURL: "https://example.test/v9",
    });

    await generateText({ model: friendli("m"), prompt: "hi" });

    expect(captured.url).toBe("https://example.test/v9/chat/completions");
  });

  it("uses the apiKey from settings as a bearer token", async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({ apiKey: "secret-token", fetch });

    await generateText({ model: friendli("m"), prompt: "hi" });

    expect(captured.headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("translates top-level reasoning into chat_template_kwargs and strips reasoning_effort", async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({ apiKey: "k", fetch });

    await generateText({
      model: friendli("m"),
      prompt: "hi",
      providerOptions: { friendli: { reasoningEffort: "high" } },
    });

    expect(captured.body.chat_template_kwargs).toEqual({
      thinking: true,
      enable_thinking: true,
    });
    expect(captured.body.reasoning_effort).toBeUndefined();
  });

  it("enables thinking from a plain top-level reasoning: 'high'", async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({ apiKey: "k", fetch });

    await generateText({
      model: friendli("m"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(captured.body.chat_template_kwargs).toEqual({
      thinking: true,
      enable_thinking: true,
    });
    expect(captured.body.reasoning_effort).toBeUndefined();
  });

  it("disables thinking from a plain top-level reasoning: 'none'", async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({ apiKey: "k", fetch });

    await generateText({
      model: friendli("m"),
      prompt: "hi",
      reasoning: "none",
    });

    expect(captured.body.chat_template_kwargs).toEqual({
      thinking: false,
      enable_thinking: false,
    });
    expect(captured.body.reasoning_effort).toBeUndefined();
  });

  it("leaves reasoning fields off the body when no reasoning is requested", async () => {
    const { fetch, captured } = captureFetch();
    const friendli = createFriendli({ apiKey: "k", fetch });

    await generateText({ model: friendli("m"), prompt: "hi" });

    expect("chat_template_kwargs" in captured.body).toBe(false);
    expect(captured.body.reasoning_effort).toBeUndefined();
  });
});
