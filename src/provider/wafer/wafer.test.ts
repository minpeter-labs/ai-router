import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { captureFetch } from "../test-utils";
import { createWafer } from "./wafer";

describe("createWafer", () => {
  it("returns a callable provider that builds a language model object", () => {
    const wafer = createWafer({ apiKey: "k" });
    expect(typeof wafer).toBe("function");

    const model = wafer("m");
    expect(model.specificationVersion).toBe("v4");
    expect(typeof model.doGenerate).toBe("function");
    expect(typeof model.doStream).toBe("function");
    expect(model.modelId).toBe("m");
    expect(model.provider).toBe("wafer.chat");
  });

  it("uses the wafer pass v1 base URL by default", async () => {
    const { fetch, captured } = captureFetch();
    const wafer = createWafer({ apiKey: "k", fetch });

    await generateText({ model: wafer("m"), prompt: "hi" });

    expect(captured.url).toBe("https://pass.wafer.ai/v1/chat/completions");
  });

  it("respects a baseURL override", async () => {
    const { fetch, captured } = captureFetch();
    const wafer = createWafer({
      apiKey: "k",
      fetch,
      baseURL: "https://example.test/v9",
    });

    await generateText({ model: wafer("m"), prompt: "hi" });

    expect(captured.url).toBe("https://example.test/v9/chat/completions");
  });

  it("uses the apiKey from settings as a bearer token", async () => {
    const { fetch, captured } = captureFetch();
    const wafer = createWafer({ apiKey: "secret-token", fetch });

    await generateText({ model: wafer("m"), prompt: "hi" });

    expect(captured.headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("translates top-level reasoning into thinking and strips reasoning_effort", async () => {
    const { fetch, captured } = captureFetch();
    const wafer = createWafer({ apiKey: "k", fetch });

    await generateText({
      model: wafer("m"),
      prompt: "hi",
      reasoning: "high",
    });

    expect(captured.body.thinking).toEqual({ type: "enabled" });
    expect(captured.body.reasoning_effort).toBeUndefined();
  });

  it("disables thinking from a plain top-level reasoning: 'none'", async () => {
    const { fetch, captured } = captureFetch();
    const wafer = createWafer({ apiKey: "k", fetch });

    await generateText({
      model: wafer("m"),
      prompt: "hi",
      reasoning: "none",
    });

    expect(captured.body.thinking).toEqual({ type: "disabled" });
    expect(captured.body.reasoning_effort).toBeUndefined();
  });

  it("does not send a ZDR header by default", async () => {
    const { fetch, captured } = captureFetch();
    const wafer = createWafer({ apiKey: "k", fetch });

    await generateText({ model: wafer("m"), prompt: "hi" });

    expect(captured.headers.has("wafer-zdr")).toBe(false);
  });

  it("sends `Wafer-ZDR: required` when zdr is enabled", async () => {
    const { fetch, captured } = captureFetch();
    const wafer = createWafer({ apiKey: "k", fetch, zdr: true });

    await generateText({ model: wafer("m"), prompt: "hi" });

    expect(captured.headers.get("wafer-zdr")).toBe("required");
  });

  it("preserves caller-supplied headers alongside the ZDR header", async () => {
    const { fetch, captured } = captureFetch();
    const wafer = createWafer({
      apiKey: "k",
      fetch,
      zdr: true,
      headers: { "x-custom": "1" },
    });

    await generateText({ model: wafer("m"), prompt: "hi" });

    expect(captured.headers.get("x-custom")).toBe("1");
    expect(captured.headers.get("wafer-zdr")).toBe("required");
  });
});
