import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { CallOptionsContractError, cloneCallOptions } from "../call-options";

describe("cloneCallOptions", () => {
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
});
