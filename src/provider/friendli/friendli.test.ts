import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { captureFetch } from "../test-utils";
import { createFriendli } from "./friendli";

describe("createFriendli", () => {
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
