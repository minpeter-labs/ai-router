import { streamText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import {
  collectStream,
  errorPartStreamModel,
  streamingModel,
} from "./test-kit";

describe("createRouter — mid-stream fallback (P0-A)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back transparently on a pre-output error part through streamText", async () => {
    const primary = errorPartStreamModel(new Error("overloaded 503"));
    const secondary = streamingModel(["from ", "secondary"]);
    const errors: unknown[] = [];

    const route = createRouter({
      models: {
        chat: [
          { provider: () => primary, model: "p", supports: ["text"] },
          { provider: () => secondary, model: "s", supports: ["text"] },
        ],
      },
      onError: ({ error }) => errors.push(error),
    });

    const acc = await collectStream(
      streamText({ model: route("chat"), prompt: "hi" })
    );
    expect(acc).toBe("from secondary");
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(secondary.doStreamCalls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("overloaded 503");
  });
});
