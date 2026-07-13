import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  CallOptionsContractError,
  cloneCallOptions,
  cloneInitialCallOptions,
} from "../call-options";

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
});
