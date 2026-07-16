import type { JSONValue } from "@ai-sdk/provider";
import { generateText, streamText, toUIMessageStream } from "ai";
import { describe, expect, it } from "vitest";
import { createOpenGateway } from "../opengateway";
import type { OpenGatewayReasoningDetailsStore } from "../reasoning-roundtrip-store";
import {
  captureBodies,
  completionResponse,
  laterReasoningDetails,
  reasoningDetails,
  repeatedReasoningDetailsTextStreamResponse,
  textReasoningDetailsOnlyStreamResponse,
} from "./test-kit";

describe("OpenGateway streamed text reasoning round-trip", () => {
  it("preserves streamed reasoning_details-only text answers into the next request", async () => {
    const { bodies, fetch } = captureBodies([
      textReasoningDetailsOnlyStreamResponse(),
      completionResponse("done"),
    ]);
    const opengateway = createOpenGateway({ apiKey: "k", fetch });

    const first = streamText({
      model: opengateway("minimax/MiniMax-M2.7"),
      prompt: "answer briefly",
    });

    const uiChunks: unknown[] = [];
    for await (const chunk of toUIMessageStream({ stream: first.stream })) {
      uiChunks.push(chunk);
    }
    expect(JSON.stringify(uiChunks)).toContain("stream ");
    expect(JSON.stringify(uiChunks)).toContain("answer");
    expect(JSON.stringify(uiChunks)).not.toContain("encrypted-mini");
    expect(JSON.stringify(uiChunks)).not.toContain("encrypted-later");

    const firstStep = await first.finalStep;
    expect(JSON.stringify(firstStep.response.messages)).not.toContain(
      "encrypted-mini"
    );
    expect(JSON.stringify(firstStep.response.messages)).not.toContain(
      "encrypted-later"
    );

    await generateText({
      model: opengateway("minimax/MiniMax-M2.7"),
      messages: [
        { role: "user", content: "first" },
        ...firstStep.response.messages,
        { role: "user", content: "continue" },
      ],
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages).toContainEqual(
      expect.objectContaining({
        reasoning_details: [...reasoningDetails, ...laterReasoningDetails],
        role: "assistant",
      })
    );
  });

  it("can replay persisted reasoningDetailsRef values through a durable store", async () => {
    const storedDetails = new Map<string, readonly JSONValue[]>();
    const reasoningDetailsStore: OpenGatewayReasoningDetailsStore = {
      load(ref) {
        return storedDetails.get(ref);
      },
      store(details) {
        const ref = `durable-ref-${storedDetails.size + 1}`;
        storedDetails.set(ref, [...details]);
        return ref;
      },
    };
    const { bodies, fetch } = captureBodies([
      textReasoningDetailsOnlyStreamResponse(),
      completionResponse("done"),
    ]);
    const opengateway = createOpenGateway({
      apiKey: "k",
      fetch,
      reasoningDetailsStore,
    });

    const first = streamText({
      model: opengateway("minimax/MiniMax-M2.7"),
      prompt: "answer briefly",
    });

    await first.consumeStream();
    const firstStep = await first.finalStep;
    const persistedMessages = JSON.parse(
      JSON.stringify(firstStep.response.messages)
    );
    expect(JSON.stringify(persistedMessages)).toContain("durable-ref-");
    expect(JSON.stringify(persistedMessages)).not.toContain("encrypted-mini");
    expect(JSON.stringify(persistedMessages)).not.toContain("encrypted-later");

    await generateText({
      model: opengateway("minimax/MiniMax-M2.7"),
      messages: [
        { role: "user", content: "first" },
        ...persistedMessages,
        { role: "user", content: "continue" },
      ],
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages).toContainEqual(
      expect.objectContaining({
        reasoning_details: [...reasoningDetails, ...laterReasoningDetails],
        role: "assistant",
      })
    );
  });

  it("stores repeated streamed reasoning_details once per stream call", async () => {
    const storeCalls: JSONValue[][] = [];
    const reasoningDetailsStore: OpenGatewayReasoningDetailsStore = {
      load() {
        return [];
      },
      store(details) {
        storeCalls.push([...details]);
        return `stream-ref-${storeCalls.length}`;
      },
    };
    const opengateway = createOpenGateway({
      apiKey: "k",
      fetch: () =>
        Promise.resolve(repeatedReasoningDetailsTextStreamResponse()),
      reasoningDetailsStore,
    });

    const result = streamText({
      model: opengateway("minimax/MiniMax-M2.7"),
      prompt: "answer briefly",
    });

    await result.consumeStream();
    expect(storeCalls).toEqual([reasoningDetails]);
  });
});
