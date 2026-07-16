import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { CallOptionsContractError, cloneCallOptions } from "../call-options";

describe("cloneCallOptions", () => {
  it("enforces role-specific prompt part contracts", () => {
    const malformed = [
      { content: [{ text: "no", type: "text" }], role: "tool" },
      { content: [{ text: "no", type: "reasoning" }], role: "user" },
      {
        content: [
          {
            input: {},
            toolCallId: "call",
            toolName: "tool",
            type: "tool-call",
          },
        ],
        role: "user",
      },
      {
        content: [
          {
            output: { type: "text", value: "result" },
            toolCallId: "call",
            toolName: "tool",
            type: "tool-result",
          },
        ],
        role: "user",
      },
      {
        content: [
          {
            approvalId: "approval",
            approved: true,
            type: "tool-approval-response",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          { input: {}, toolCallId: "", toolName: "tool", type: "tool-call" },
        ],
        role: "assistant",
      },
      {
        content: [{ toolCallId: "call", toolName: "tool", type: "tool-call" }],
        role: "assistant",
      },
      {
        content: [
          {
            input: {},
            toolCallId: "x".repeat(4097),
            toolName: "tool",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      { content: [], role: "unknown" },
      { content: [{ type: "future-part" }], role: "assistant" },
    ];

    for (const message of malformed) {
      expect(() =>
        cloneCallOptions(
          { prompt: [message] } as unknown as LanguageModelV4CallOptions,
          undefined
        )
      ).toThrow(CallOptionsContractError);
    }
  });

  it("rejects malformed file data and tool output variants", () => {
    const malformedParts = [
      { data: { type: "unknown" }, mediaType: "text/plain", type: "file" },
      {
        data: { data: 42, type: "data" },
        mediaType: "text/plain",
        type: "file",
      },
      {
        data: { reference: { provider: 42 }, type: "reference" },
        mediaType: "text/plain",
        type: "file",
      },
      {
        data: { reference: { mock: "id" }, type: "reference" },
        mediaType: "text/plain",
        type: "reasoning-file",
      },
      {
        output: { type: "text", value: 42 },
        toolCallId: "call",
        toolName: "tool",
        type: "tool-result",
      },
      {
        output: { type: "execution-denied", reason: 42 },
        toolCallId: "call",
        toolName: "tool",
        type: "tool-result",
      },
      {
        output: { type: "json" },
        toolCallId: "call",
        toolName: "tool",
        type: "tool-result",
      },
      {
        output: { type: "content", value: new Array(1) },
        toolCallId: "call",
        toolName: "tool",
        type: "tool-result",
      },
    ];

    for (const part of malformedParts) {
      let role = "tool";
      if (part.type === "file") {
        role = "user";
      } else if (part.type === "reasoning-file") {
        role = "assistant";
      }
      expect(() =>
        cloneCallOptions(
          { prompt: [{ content: [part], role }] } as LanguageModelV4CallOptions,
          undefined
        )
      ).toThrow(CallOptionsContractError);
    }
  });

  it("accepts custom content in tool outputs and snapshots its options", () => {
    const providerOptions = { mock: { mode: "before" } };
    const options = {
      prompt: [
        {
          content: [
            {
              output: {
                type: "content",
                value: [{ providerOptions, type: "custom" }],
              },
              toolCallId: "call",
              toolName: "tool",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
    } as LanguageModelV4CallOptions;

    const cloned = cloneCallOptions(options, undefined);
    providerOptions.mock.mode = "after";

    expect(cloned.prompt).toEqual([
      {
        content: [
          {
            output: {
              providerOptions: undefined,
              type: "content",
              value: [
                {
                  providerOptions: { mock: { mode: "before" } },
                  type: "custom",
                },
              ],
            },
            providerOptions: undefined,
            toolCallId: "call",
            toolName: "tool",
            type: "tool-result",
          },
        ],
        providerOptions: undefined,
        role: "tool",
      },
    ]);
  });

  it("snapshots prompt JSON and safely preserves special reference keys", () => {
    const providerOptions = { mock: { mode: "before" } };
    const reference = Object.create(null) as Record<string, string>;
    Object.defineProperty(reference, "__proto__", {
      enumerable: true,
      value: "remote-id",
    });
    const options = {
      prompt: [
        {
          content: [
            {
              data: { reference, type: "reference" },
              mediaType: "text/plain",
              providerOptions,
              type: "file",
            },
          ],
          role: "user",
        },
      ],
    } as LanguageModelV4CallOptions;

    const cloned = cloneCallOptions(options, undefined);
    providerOptions.mock.mode = "after";
    const part = cloned.prompt[0].content[0] as unknown as {
      data: { reference: Record<string, string> };
      providerOptions: { mock: { mode: string } };
    };

    expect(part.providerOptions.mock.mode).toBe("before");
    expect(Object.hasOwn(part.data.reference, "__proto__")).toBe(true);
    expect(Reflect.get(part.data.reference, "__proto__")).toBe("remote-id");
    expect(Object.getPrototypeOf(part.data.reference)).toBe(Object.prototype);
  });
});
