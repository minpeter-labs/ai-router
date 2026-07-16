import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { CallOptionsContractError, cloneCallOptions } from "../call-options";

describe("cloneCallOptions", () => {
  it("copies mutable attempt containers while preserving opaque leaves", () => {
    const bytes = new Uint8Array([1, 2]);
    const options: LanguageModelV4CallOptions = {
      headers: { authorization: "secret" },
      prompt: [
        {
          content: [
            {
              providerOptions: { mock: { stable: true } },
              text: "hi",
              type: "text",
            },
            {
              data: { data: bytes, type: "data" },
              mediaType: "image/png",
              type: "file",
            },
          ],
          role: "user",
        },
      ],
      providerOptions: { mock: { mode: "stable" } },
      stopSequences: ["stop"],
    };

    const cloned = cloneCallOptions(options, undefined);
    const originalContent = options.prompt[0].content;
    const clonedContent = cloned.prompt[0].content;

    expect(cloned).not.toBe(options);
    expect(cloned.prompt).not.toBe(options.prompt);
    expect(clonedContent).not.toBe(originalContent);
    expect(clonedContent[0]).not.toBe(originalContent[0]);
    expect(cloned.providerOptions).not.toBe(options.providerOptions);
    expect(cloned.providerOptions?.mock).not.toBe(
      options.providerOptions?.mock
    );
    expect(
      (clonedContent[0] as { providerOptions?: { mock?: unknown } })
        .providerOptions?.mock
    ).not.toBe(
      (originalContent[0] as { providerOptions?: { mock?: unknown } })
        .providerOptions?.mock
    );
    expect((clonedContent[1] as { data: { data: Uint8Array } }).data.data).toBe(
      bytes
    );
    expect(cloned.headers).not.toBe(options.headers);
    expect(cloned.stopSequences).not.toBe(options.stopSequences);
  });

  it("surfaces hostile input accessors as request contract errors", () => {
    const part = Object.defineProperty({ type: "text" }, "text", {
      enumerable: true,
      get() {
        throw new Error("text getter failed");
      },
    });
    const options = {
      prompt: [{ content: [part], role: "user" }],
    } as LanguageModelV4CallOptions;

    expect(() => cloneCallOptions(options, undefined)).toThrow(
      CallOptionsContractError
    );
    try {
      cloneCallOptions(options, undefined);
    } catch (error) {
      expect(error).toMatchObject({ code: "call_options_contract_error" });
    }
  });

  it("rejects sparse, oversized, and malformed option collections", () => {
    const base: LanguageModelV4CallOptions = {
      prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
    };
    const malformed = [
      { ...base, prompt: new Array(1) },
      { ...base, prompt: new Array(10_001) },
      {
        ...base,
        prompt: [{ content: new Array(1), role: "user" }],
      },
      { ...base, stopSequences: new Array(1) },
      { ...base, stopSequences: new Array(1025) },
      { ...base, stopSequences: [42] },
      { ...base, stopSequences: [""] },
      { ...base, stopSequences: ["x".repeat(65_537)] },
      {
        ...base,
        stopSequences: Array.from({ length: 17 }, () => "x".repeat(65_536)),
      },
      { ...base, tools: new Array(1) },
      { ...base, tools: new Array(1025) },
      { ...base, headers: { invalid: 42 } },
      { ...base, headers: { "bad header": "value" } },
      { ...base, headers: { valid: "first\r\nInjected: true" } },
      { ...base, headers: { valid: "nul\0value" } },
      {
        ...base,
        headers: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [
            `x-large-${index}`,
            "x".repeat(65_536),
          ])
        ),
      },
      {
        ...base,
        headers: Object.fromEntries(
          Array.from({ length: 1025 }, (_, index) => [`x-${index}`, "value"])
        ),
      },
    ];

    for (const options of malformed) {
      expect(() =>
        cloneCallOptions(options as LanguageModelV4CallOptions, undefined)
      ).toThrow(CallOptionsContractError);
    }
  });

  it("rejects malformed scalar, policy, tool, and signal options", () => {
    const base: LanguageModelV4CallOptions = {
      prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
    };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const malformed = [
      { ...base, temperature: Number.NaN },
      { ...base, topP: Number.POSITIVE_INFINITY },
      { ...base, maxOutputTokens: 0 },
      { ...base, maxOutputTokens: 1.5 },
      { ...base, seed: 1.5 },
      { ...base, includeRawChunks: "yes" },
      { ...base, reasoning: "extreme" },
      { ...base, responseFormat: { type: "xml" } },
      { ...base, responseFormat: { schema: circular, type: "json" } },
      { ...base, toolChoice: { type: "tool" } },
      { ...base, toolChoice: { type: "random" } },
      { ...base, toolChoice: { toolName: "missing", type: "tool" } },
      { ...base, tools: [{ inputSchema: {}, type: "function" }] },
      {
        ...base,
        tools: [
          { inputSchema: {}, name: "duplicate", type: "function" },
          { inputSchema: {}, name: "duplicate", type: "function" },
        ],
      },
      {
        ...base,
        tools: [{ inputSchema: {}, name: "", type: "function" }],
      },
      {
        ...base,
        tools: [{ name: "missing-schema", type: "function" }],
      },
      {
        ...base,
        tools: [{ args: [], id: "mock.tool", name: "tool", type: "provider" }],
      },
      {
        ...base,
        tools: [{ args: {}, id: "invalid", name: "tool", type: "provider" }],
      },
      {
        ...base,
        tools: [
          {
            args: new Date(0),
            id: "mock.tool",
            name: "tool",
            type: "provider",
          },
        ],
      },
    ];

    for (const options of malformed) {
      expect(() =>
        cloneCallOptions(options as LanguageModelV4CallOptions, undefined)
      ).toThrow(CallOptionsContractError);
    }
    expect(() => cloneCallOptions(base, "signal" as never)).toThrow(
      CallOptionsContractError
    );
  });
});
