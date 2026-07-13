import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  CallOptionsContractError,
  cloneCallOptions,
  cloneInitialCallOptions,
} from "./call-options";

describe("cloneCallOptions", () => {
  it("captures a hostile initial abortSignal getter after consuming root Promise siblings", async () => {
    let reads = 0;
    const options = Object.defineProperty(
      {
        prompt: [],
        topP: Promise.reject(new Error("async sibling")),
      },
      "abortSignal",
      {
        get() {
          reads += 1;
          throw new Error("signal getter failed");
        },
      }
    ) as unknown as LanguageModelV4CallOptions;

    expect(() => cloneInitialCallOptions(options)).toThrow(
      CallOptionsContractError
    );
    expect(reads).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes Promise-valued root and discriminated option fields", async () => {
    expect(() =>
      cloneInitialCallOptions(
        Promise.reject(new Error("async call options")) as never
      )
    ).toThrow(CallOptionsContractError);
    expect(() =>
      cloneInitialCallOptions({
        frequencyPenalty: Promise.reject(new Error("async penalty")),
        prompt: [Promise.reject(new Error("async prompt entry"))] as never,
        responseFormat: {
          description: Promise.reject(new Error("async format description")),
          name: Promise.reject(new Error("async format name")),
          schema: Promise.reject(new Error("async format schema")),
          type: Promise.reject(new Error("async format type")),
        } as never,
        stopSequences: [
          Promise.reject(new Error("async stop sequence")),
        ] as never,
        toolChoice: {
          toolName: Promise.reject(new Error("async tool name")),
          type: Promise.reject(new Error("async tool-choice type")),
        } as never,
        tools: [Promise.reject(new Error("async tool entry"))] as never,
      } as never)
    ).toThrow(CallOptionsContractError);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("consumes Promise-valued nested call fields before rejecting", async () => {
    const prompt = [{ content: [{ text: "hi", type: "text" }], role: "user" }];
    const malformed = [
      {
        prompt: [
          {
            content: Promise.reject(new Error("async message content")),
            providerOptions: Promise.reject(
              new Error("async message providerOptions")
            ),
            role: Promise.reject(new Error("async message role")),
          },
        ],
      },
      {
        prompt: [
          {
            content: [
              {
                data: Promise.reject(new Error("async part data")),
                providerOptions: Promise.reject(
                  new Error("async part providerOptions")
                ),
                text: Promise.reject(new Error("async part text")),
                type: Promise.reject(new Error("async part type")),
              },
            ],
            role: "user",
          },
        ],
      },
      {
        prompt: [
          {
            content: [
              {
                data: {
                  data: Promise.reject(new Error("async file bytes")),
                  reference: Promise.reject(new Error("async file reference")),
                  type: "data",
                  url: Promise.reject(new Error("async file URL")),
                },
                mediaType: "application/octet-stream",
                type: "file",
              },
            ],
            role: "user",
          },
        ],
      },
      {
        prompt,
        tools: [
          {
            inputExamples: Promise.reject(new Error("async examples")),
            inputSchema: Promise.reject(new Error("async schema")),
            name: Promise.reject(new Error("async tool name")),
            providerOptions: Promise.reject(new Error("async tool options")),
            type: Promise.reject(new Error("async tool type")),
          },
        ],
      },
      {
        prompt: [
          {
            content: [
              {
                output: {
                  providerOptions: Promise.reject(
                    new Error("async output options")
                  ),
                  reason: Promise.reject(new Error("async output reason")),
                  type: Promise.reject(new Error("async output type")),
                  value: Promise.reject(new Error("async output value")),
                },
                toolCallId: "call",
                toolName: "tool",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
        ],
      },
    ];

    for (const options of malformed) {
      expect(() => cloneCallOptions(options as never, undefined)).toThrow(
        CallOptionsContractError
      );
    }

    const headers = Object.defineProperties(
      {},
      {
        "bad header": {
          enumerable: true,
          get() {
            throw new Error("invalid header value must not be read");
          },
        },
        later: {
          enumerable: true,
          value: Promise.reject(new Error("async later header")),
        },
      }
    );
    expect(() =>
      cloneCallOptions({ headers, prompt } as never, undefined)
    ).toThrow(CallOptionsContractError);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not inspect arbitrary thenables in nested synchronous fields", () => {
    let thenReads = 0;
    const thenKey = ["th", "en"].join("");
    const thenable = Object.defineProperty({}, thenKey, {
      get() {
        thenReads += 1;
        throw new Error("then must not be inspected");
      },
    });

    expect(() =>
      cloneCallOptions(
        {
          prompt: [{ content: [{ text: "hi", type: thenable }], role: "user" }],
        } as never,
        undefined
      )
    ).toThrow(CallOptionsContractError);
    expect(thenReads).toBe(0);
  });

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

  it("bounds aggregate JSON containers across prompt parts", () => {
    const content = Array.from({ length: 6 }, (_, index) => ({
      providerOptions: {
        mock: { items: Array.from({ length: 9000 }, () => ({})) },
      },
      text: `part-${index}`,
      type: "text" as const,
    }));
    const options = {
      prompt: [{ content, role: "user" }],
    } as LanguageModelV4CallOptions;

    expect(() => cloneCallOptions(options, undefined)).toThrow(
      CallOptionsContractError
    );
  });

  it("bounds aggregate JSON string and key characters across prompt parts", () => {
    const payload = "x".repeat(1_000_000);
    const content = Array.from({ length: 5 }, (_, index) => ({
      providerOptions: { mock: { payload } },
      text: `part-${index}`,
      type: "text" as const,
    }));
    const options = {
      prompt: [{ content, role: "user" }],
    } as LanguageModelV4CallOptions;

    expect(() => cloneCallOptions(options, undefined)).toThrow(
      CallOptionsContractError
    );
  });

  it("bounds aggregate metadata while leaving prompt body text unrestricted", () => {
    const body = "x".repeat(100_000);
    const valid = cloneCallOptions(
      {
        prompt: [{ content: [{ text: body, type: "text" }], role: "user" }],
      },
      undefined
    );
    expect((valid.prompt[0].content[0] as { text: string }).text).toBe(body);

    const description = "d".repeat(60_000);
    const tools = Array.from({ length: 70 }, (_, index) => ({
      description,
      inputSchema: {},
      name: `tool-${index}`,
      type: "function" as const,
    }));
    expect(() =>
      cloneCallOptions(
        {
          prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
          tools,
        },
        undefined
      )
    ).toThrow(CallOptionsContractError);

    expect(() =>
      cloneCallOptions(
        {
          prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
          responseFormat: {
            description: "d".repeat(65_537),
            name: "structured-output",
            type: "json",
          },
        },
        undefined
      )
    ).toThrow(CallOptionsContractError);

    expect(() =>
      cloneCallOptions(
        {
          prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
          responseFormat: {
            name: "n".repeat(4097),
            type: "json",
          },
        },
        undefined
      )
    ).toThrow(CallOptionsContractError);
  });

  it("allows empty optional metadata strings", () => {
    expect(() =>
      cloneCallOptions(
        {
          prompt: [
            {
              content: [
                {
                  data: { text: "body", type: "text" },
                  filename: "",
                  mediaType: "text/plain",
                  type: "file",
                },
              ],
              role: "user",
            },
          ],
          tools: [
            {
              description: "",
              inputSchema: {},
              name: "lookup",
              type: "function",
            },
          ],
        },
        undefined
      )
    ).not.toThrow();
  });

  it("reads each prompt message field exactly once", () => {
    const reads = { content: 0, providerOptions: 0, role: 0 };
    const message = Object.defineProperties(
      {},
      {
        content: {
          get() {
            reads.content += 1;
            return [{ text: "stable", type: "text" }];
          },
        },
        providerOptions: {
          get() {
            reads.providerOptions += 1;
            return { mock: { stable: true } };
          },
        },
        role: {
          get() {
            reads.role += 1;
            return "user";
          },
        },
      }
    );

    const cloned = cloneCallOptions(
      { prompt: [message] } as unknown as LanguageModelV4CallOptions,
      undefined
    );

    expect(reads).toEqual({ content: 1, providerOptions: 1, role: 1 });
    expect(cloned.prompt).toEqual([
      {
        content: [{ providerOptions: undefined, text: "stable", type: "text" }],
        providerOptions: { mock: { stable: true } },
        role: "user",
      },
    ]);
  });

  it("reads known top-level fields once and drops unknown fields", () => {
    const reads = { prompt: 0, temperature: 0, unknown: 0 };
    const options = Object.defineProperties(
      {},
      {
        prompt: {
          enumerable: true,
          get() {
            reads.prompt += 1;
            return [{ content: [{ text: "hi", type: "text" }], role: "user" }];
          },
        },
        temperature: {
          enumerable: true,
          get() {
            reads.temperature += 1;
            return 0.5;
          },
        },
        unknown: {
          enumerable: true,
          get() {
            reads.unknown += 1;
            throw new Error("unknown fields must not be evaluated");
          },
        },
      }
    ) as LanguageModelV4CallOptions & { unknown?: unknown };

    const cloned = cloneCallOptions(options, undefined);

    expect(reads).toEqual({ prompt: 1, temperature: 1, unknown: 0 });
    expect(cloned.temperature).toBe(0.5);
    expect(Object.hasOwn(cloned, "unknown")).toBe(false);
  });

  it("reads tool fields once and drops unknown tool fields", () => {
    const reads = { inputSchema: 0, name: 0, type: 0, unknown: 0 };
    const tool = Object.defineProperties(
      {},
      {
        inputSchema: {
          enumerable: true,
          get() {
            reads.inputSchema += 1;
            return { type: "object" };
          },
        },
        name: {
          enumerable: true,
          get() {
            reads.name += 1;
            return "lookup";
          },
        },
        type: {
          enumerable: true,
          get() {
            reads.type += 1;
            return "function";
          },
        },
        unknown: {
          enumerable: true,
          get() {
            reads.unknown += 1;
            throw new Error("unknown tool fields must not be evaluated");
          },
        },
      }
    );
    const options = {
      prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
      tools: [tool],
    } as unknown as LanguageModelV4CallOptions;

    const cloned = cloneCallOptions(options, undefined);

    expect(reads).toEqual({ inputSchema: 1, name: 1, type: 1, unknown: 0 });
    expect(cloned.tools?.[0]).toMatchObject({
      inputSchema: { type: "object" },
      name: "lookup",
      type: "function",
    });
    expect(Object.hasOwn(cloned.tools?.[0] ?? {}, "unknown")).toBe(false);
  });

  it("snapshots array indexes once before validation and cloning", () => {
    const reads = { content: 0, prompt: 0, stop: 0, tools: 0 };
    const once = <T>(items: T[], key: keyof typeof reads): T[] =>
      new Proxy(items, {
        get(target, property, receiver) {
          if (property === "0") {
            reads[key] += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      });
    const content = once([{ text: "hi", type: "text" }], "content");
    const prompt = once([{ content, role: "user" }], "prompt");
    const stopSequences = once(["stop"], "stop");
    const tools = once(
      [{ inputSchema: {}, name: "lookup", type: "function" }],
      "tools"
    );

    const cloned = cloneCallOptions(
      { prompt, stopSequences, tools } as LanguageModelV4CallOptions,
      undefined
    );

    expect(reads).toEqual({ content: 1, prompt: 1, stop: 1, tools: 1 });
    expect(cloned.stopSequences).toEqual(["stop"]);
    expect(cloned.tools?.[0]).toMatchObject({ name: "lookup" });
  });

  it("rejects invalid header names without reading their values", () => {
    let reads = 0;
    const headers = Object.defineProperty({}, "bad header", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("must not be read");
      },
    });
    const options = {
      headers,
      prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
    } as LanguageModelV4CallOptions;

    expect(() => cloneCallOptions(options, undefined)).toThrow(
      CallOptionsContractError
    );
    expect(reads).toBe(0);
  });
});
