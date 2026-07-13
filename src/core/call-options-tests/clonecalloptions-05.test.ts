import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { CallOptionsContractError, cloneCallOptions } from "../call-options";

describe("cloneCallOptions", () => {
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
