import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { captureFetch } from "../test-utils";
import { createOpenGateway } from "./opengateway";

describe("createOpenGateway", () => {
  it("returns a callable provider that builds a language model object", () => {
    const opengateway = createOpenGateway({ apiKey: "k" });
    expect(typeof opengateway).toBe("function");

    const model = opengateway("openai/gpt-4o-mini");
    expect(model.specificationVersion).toBe("v4");
    expect(typeof model.doGenerate).toBe("function");
    expect(typeof model.doStream).toBe("function");
    expect(model.modelId).toBe("openai/gpt-4o-mini");
    expect(model.provider).toBe("opengateway.chat");
  });

  it("uses the OpenGateway v1 base URL by default", async () => {
    const { fetch, captured } = captureFetch();
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    await generateText({
      model: opengateway("openai/gpt-4o-mini"),
      prompt: "hi",
    });

    expect(captured.url).toBe(
      "https://apis.opengateway.ai/v1/chat/completions"
    );
  });

  it("respects a baseURL override", async () => {
    const { fetch, captured } = captureFetch();
    const opengateway = createOpenGateway({
      apiKey: "k",
      fetch,
      baseURL: "https://example.test/v9",
    });

    await generateText({
      model: opengateway("openai/gpt-4o-mini"),
      prompt: "hi",
    });

    expect(captured.url).toBe("https://example.test/v9/chat/completions");
  });

  it("uses the apiKey from settings as a bearer token", async () => {
    const { fetch, captured } = captureFetch();
    const opengateway = createOpenGateway({ apiKey: "secret-token", fetch });

    await generateText({
      model: opengateway("openai/gpt-4o-mini"),
      prompt: "hi",
    });

    expect(captured.headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("passes top-level reasoning through as reasoning_effort", async () => {
    const { fetch, captured } = captureFetch();
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    await generateText({
      model: opengateway("openai/gpt-4o-mini"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(captured.body.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort for plain top-level reasoning: 'none'", async () => {
    const { fetch, captured } = captureFetch();
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    await generateText({
      model: opengateway("openai/gpt-4o-mini"),
      prompt: "hi",
      reasoning: "none",
    });

    expect(captured.body.reasoning_effort).toBeUndefined();
  });
});
