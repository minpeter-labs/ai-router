import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { generateText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import type { FusionAnalysis, FusionEvent } from "./fusion";
import { createFusion } from "./fusion";
import { createRouter } from "./router";

// ---------------------------------------------------------------------------
// V4 building blocks (same nested usage + object finishReason as router.test.ts)
// ---------------------------------------------------------------------------
const usage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const finishReason = { unified: "stop" as const, raw: "stop" };

const usageOf = (n: number): LanguageModelV4Usage => ({
  inputTokens: { total: n, noCache: n, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: n * 2, text: n * 2, reasoning: 0 },
});

type Gen = LanguageModelV4CallOptions;

/** A recording doGenerate mock returning fixed text. */
function genModel(text = "out", u: LanguageModelV4Usage = usage) {
  const calls: Gen[] = [];
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock",
    doGenerate: (o: Gen) => {
      calls.push(o);
      return Promise.resolve({
        content: [{ type: "text", text }],
        finishReason,
        usage: u,
        warnings: [],
      });
    },
  });
  return { model, calls };
}

/** A judge mock that returns a JSON analysis. */
function judgeModel(
  analysis: Partial<FusionAnalysis>,
  u: LanguageModelV4Usage = usage
) {
  return genModel(JSON.stringify(analysis), u);
}

/** A doGenerate mock that always throws. */
function failGen(message = "panel fail") {
  return new MockLanguageModelV4({
    doGenerate: () => Promise.reject(new Error(message)),
  });
}

/** A recording doStream mock emitting the given text deltas. */
function streamModel(
  parts: string[] = ["Hel", "lo"],
  u: LanguageModelV4Usage = usage
) {
  const calls: Gen[] = [];
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock",
    doStream: (o: Gen) => {
      calls.push(o);
      return Promise.resolve({
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "s1" },
            ...parts.map((delta) => ({
              type: "text-delta" as const,
              id: "s1",
              delta,
            })),
            { type: "text-end", id: "s1" },
            { type: "finish", finishReason, usage: u },
          ],
        }),
      });
    },
  });
  return { model, calls };
}

const sample: FusionAnalysis = {
  consensus: ["X is generally true"],
  contradictions: [],
  partialCoverage: [],
  uniqueInsights: [{ label: "Model B", insight: "an edge case" }],
  blindSpots: [],
  ranking: [{ label: "Model A", reason: "most complete" }],
  synthesisGuidance: "Lead with X.",
};

const textPrompt: LanguageModelV4Prompt = [
  { role: "user", content: [{ type: "text", text: "Explain X" }] },
];
const opts = (prompt: LanguageModelV4Prompt = textPrompt): Gen => ({ prompt });

const imagePart = {
  type: "file" as const,
  mediaType: "image/png",
  data: { type: "url" as const, url: new URL("https://example.com/image.png") },
};
const imagePrompt: LanguageModelV4Prompt = [
  { role: "user", content: [imagePart] },
];

const textOfContent = (content: ReadonlyArray<{ type: string }>): string =>
  content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

async function collectParts(
  stream: ReadableStream<LanguageModelV4StreamPart>
): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    parts.push(value);
  }
  return parts;
}

const streamText = (parts: LanguageModelV4StreamPart[]): string =>
  parts
    .filter(
      (p): p is Extract<LanguageModelV4StreamPart, { type: "text-delta" }> =>
        p.type === "text-delta"
    )
    .map((p) => p.delta)
    .join("");

// ---------------------------------------------------------------------------
// Construction & config validation
// ---------------------------------------------------------------------------
describe("createFusion — construction", () => {
  it("throws when the panel has fewer than 2 members", () => {
    expect(() => createFusion({ panel: [genModel().model] })).toThrow(
      "at least 2"
    );
  });

  it("throws on an empty fallback list", () => {
    expect(() =>
      createFusion({ panel: [{ fallback: [] }, genModel().model] })
    ).toThrow("fallback list must be non-empty");
  });

  it("throws when minPanelSuccess < 1", () => {
    expect(() =>
      createFusion({
        panel: [genModel().model, genModel().model],
        minPanelSuccess: 0,
      })
    ).toThrow("minPanelSuccess must be >= 1");
  });

  it("throws when a fusion model is used directly as its own member", () => {
    const inner = createFusion({ panel: [genModel().model, genModel().model] });
    expect(() => createFusion({ panel: [inner, genModel().model] })).toThrow(
      "cannot be used directly as its own"
    );
  });

  it("reports a v4 identity and resolvable supportedUrls", async () => {
    const fusion = createFusion({
      panel: [genModel().model, genModel().model],
    });
    expect(fusion.specificationVersion).toBe("v4");
    expect(fusion.provider).toBe("fusion");
    expect(fusion.modelId).toBe("fusion");
    expect(await Promise.resolve(fusion.supportedUrls)).toBeTypeOf("object");
  });

  it("honors custom providerId/modelId", () => {
    const fusion = createFusion({
      panel: [genModel().model, genModel().model],
      providerId: "p",
      modelId: "m",
    });
    expect(fusion.provider).toBe("p");
    expect(fusion.modelId).toBe("m");
  });
});

// ---------------------------------------------------------------------------
// doGenerate — happy path
// ---------------------------------------------------------------------------
describe("createFusion — doGenerate", () => {
  it("runs panel -> judge -> synth and returns the synth answer", async () => {
    const a = genModel("answer a");
    const b = genModel("answer b");
    const c = genModel("answer c");
    const judge = judgeModel(sample);
    const synth = genModel("FINAL ANSWER");
    const fusion = createFusion({
      panel: [a.model, b.model, c.model],
      judge: judge.model,
      synth: synth.model,
    });

    const result = await fusion.doGenerate(opts());

    expect(textOfContent(result.content)).toBe("FINAL ANSWER");
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(c.calls).toHaveLength(1);
    expect(judge.calls).toHaveLength(1);
    expect(synth.calls).toHaveLength(1);
  });

  it("applies stage temperatures and a JSON responseFormat to the judge", async () => {
    const a = genModel("a");
    const b = genModel("b");
    const judge = judgeModel(sample);
    const synth = genModel("final");
    const fusion = createFusion({
      panel: [a.model, b.model],
      judge: judge.model,
      synth: synth.model,
    });

    await fusion.doGenerate(opts());

    expect(a.calls[0].temperature).toBe(0.7);
    expect(judge.calls[0].temperature).toBe(0);
    expect(judge.calls[0].responseFormat?.type).toBe("json");
    expect(synth.calls[0].temperature).toBe(0.3);
  });

  it("exposes the structured analysis and panel stats on providerMetadata.fusion", async () => {
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model, genModel("c").model],
      judge: judgeModel(sample).model,
      synth: genModel("final").model,
    });

    const result = await fusion.doGenerate(opts());
    const meta = result.providerMetadata?.fusion as Record<string, any>;

    expect(meta.analysis).toEqual(sample);
    expect(meta.panel.survived).toBe(3);
    expect(meta.panel.failed).toBe(0);
    expect(meta.degraded).toBeNull();
    expect(meta.synthSource).toBe("synth");
  });

  it("aggregates usage across panel + judge + synth", async () => {
    const fusion = createFusion({
      panel: [
        genModel("a", usageOf(1)).model,
        genModel("b", usageOf(2)).model,
        genModel("c", usageOf(3)).model,
      ],
      judge: judgeModel(sample, usageOf(4)).model,
      synth: genModel("final", usageOf(5)).model,
    });

    const result = await fusion.doGenerate(opts());

    expect(result.usage.inputTokens.total).toBe(15);
    expect(result.usage.outputTokens.total).toBe(30);
  });

  it("reports the synth finishReason, not the panel one", async () => {
    const synth = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "final" }],
        finishReason: { unified: "length", raw: "length" },
        usage,
        warnings: [],
      }),
    });
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth,
    });

    const result = await fusion.doGenerate(opts());
    expect(result.finishReason.unified).toBe("length");
  });
});

// ---------------------------------------------------------------------------
// Role defaulting
// ---------------------------------------------------------------------------
describe("createFusion — role defaulting", () => {
  it("defaults judge and synth to the first surviving panel member", async () => {
    const a = judgeModel(sample); // first member doubles as judge + synth
    const b = genModel("b");
    const fusion = createFusion({ panel: [a.model, b.model] });

    await fusion.doGenerate(opts());

    expect(a.calls).toHaveLength(3); // panel + judge + synth
    expect(b.calls).toHaveLength(1); // panel only
  });

  it("defaults synth to the judge when only judge is given", async () => {
    const judge = judgeModel(sample);
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judge.model,
    });

    await fusion.doGenerate(opts());
    expect(judge.calls).toHaveLength(2); // judge + synth
  });
});

// ---------------------------------------------------------------------------
// includeAnalysis
// ---------------------------------------------------------------------------
describe("createFusion — includeAnalysis", () => {
  it("default 'metadata' keeps the answer text clean and attaches metadata", async () => {
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: genModel("FINAL").model,
    });
    const result = await fusion.doGenerate(opts());

    expect(result.content.every((c) => c.type === "text")).toBe(true);
    expect(textOfContent(result.content)).toBe("FINAL");
    expect(result.providerMetadata?.fusion).toBeDefined();
  });

  it("'reasoning' prepends the analysis as a reasoning part", async () => {
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: genModel("FINAL").model,
      includeAnalysis: "reasoning",
    });
    const result = await fusion.doGenerate(opts());

    expect(result.content[0].type).toBe("reasoning");
    expect((result.content[0] as { text: string }).text).toContain("Consensus");
    expect(textOfContent(result.content)).toBe("FINAL");
  });

  it("false omits providerMetadata.fusion entirely", async () => {
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: genModel("FINAL").model,
      includeAnalysis: false,
    });
    const result = await fusion.doGenerate(opts());

    expect(result.providerMetadata).toBeUndefined();
    expect(result.content.some((c) => c.type === "reasoning")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Modality filtering
// ---------------------------------------------------------------------------
describe("createFusion — modality", () => {
  it("'filter' drops fallback members that cannot handle the modalities", async () => {
    const textOnly = genModel("text-only");
    const imageOk = genModel("image-ok");
    const dropped: string[] = [];
    const fusion = createFusion({
      panel: [
        {
          model: {
            fallback: [
              {
                provider: () => textOnly.model,
                model: "t",
                supports: ["text"],
              },
            ],
          },
          label: "T",
        },
        {
          model: {
            fallback: [
              {
                provider: () => imageOk.model,
                model: "i",
                supports: ["text", "image"],
              },
            ],
          },
          label: "I",
        },
      ],
      onEvent: (e) => {
        if (e.type === "panel:selected") {
          dropped.push(...e.dropped.map((d) => d.label));
        }
      },
    });

    await fusion.doGenerate(opts(imagePrompt));

    expect(textOnly.calls).toHaveLength(0); // never invoked
    expect(imageOk.calls).toHaveLength(3); // lone survivor doubles as panel + judge + synth
    expect(dropped).toContain("T");
  });

  it("'error' throws before any panel call when a declared member can't handle the prompt", async () => {
    const textOnly = genModel("text-only");
    const imageOk = genModel("image-ok");
    const fusion = createFusion({
      panel: [
        {
          model: {
            fallback: [
              {
                provider: () => textOnly.model,
                model: "t",
                supports: ["text"],
              },
            ],
          },
        },
        {
          model: {
            fallback: [
              {
                provider: () => imageOk.model,
                model: "i",
                supports: ["text", "image"],
              },
            ],
          },
        },
      ],
      modalityBehavior: "error",
    });

    await expect(fusion.doGenerate(opts(imagePrompt))).rejects.toThrow(
      "cannot handle"
    );
    expect(textOnly.calls).toHaveLength(0);
    expect(imageOk.calls).toHaveLength(0);
  });

  it("keeps opaque bare members regardless of modality", async () => {
    const bare = genModel("bare");
    const fusion = createFusion({
      panel: [bare.model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: genModel("final").model,
    });
    await fusion.doGenerate(opts(imagePrompt));
    expect(bare.calls).toHaveLength(1); // panel only; judge/synth are explicit
  });
});

// ---------------------------------------------------------------------------
// Per-member fallback (router reuse)
// ---------------------------------------------------------------------------
describe("createFusion — per-member fallback", () => {
  it("a {fallback} member recovers from its own failing entry", async () => {
    const ok = genModel("recovered");
    const fusion = createFusion({
      panel: [
        {
          model: {
            fallback: [
              { provider: () => failGen(), model: "bad", supports: ["text"] },
              { provider: () => ok.model, model: "good", supports: ["text"] },
            ],
          },
          label: "A",
        },
        genModel("b").model,
      ],
      judge: judgeModel(sample).model,
      synth: genModel("final").model,
    });

    const result = await fusion.doGenerate(opts());
    const meta = result.providerMetadata?.fusion as Record<string, any>;
    expect(meta.panel.survived).toBe(2);
    expect(ok.calls).toHaveLength(1); // recovered entry used once (panel); judge/synth explicit
  });
});

// ---------------------------------------------------------------------------
// Fault tolerance
// ---------------------------------------------------------------------------
describe("createFusion — fault tolerance", () => {
  it("survives a panel member failure and reports it", async () => {
    const errors: string[] = [];
    const judge = judgeModel(sample);
    const fusion = createFusion({
      panel: [genModel("a").model, failGen("boom"), genModel("c").model],
      judge: judge.model,
      synth: genModel("final").model,
      onError: (i) => errors.push(`${i.stage}:${i.label}`),
    });

    const result = await fusion.doGenerate(opts());
    const meta = result.providerMetadata?.fusion as Record<string, any>;

    expect(meta.panel.survived).toBe(2);
    expect(meta.panel.failed).toBe(1);
    expect(errors.filter((e) => e.startsWith("panel:"))).toHaveLength(1);
    // judge prompt only mentions the two survivors
    const judgePromptText = JSON.stringify(judge.calls[0].prompt);
    expect(judgePromptText).toContain("Model A");
    expect(judgePromptText).toContain("Model C");
  });

  it("rejects when every panel member fails", async () => {
    const fusion = createFusion({
      panel: [failGen("a"), failGen("b")],
      judge: judgeModel(sample).model,
      synth: genModel("final").model,
    });
    await expect(fusion.doGenerate(opts())).rejects.toThrow(
      "all panel members failed"
    );
  });

  it("rejects below minPanelSuccess by default and skips judge/synth", async () => {
    const judge = judgeModel(sample);
    const synth = genModel("final");
    const fusion = createFusion({
      panel: [genModel("a").model, failGen("b")],
      judge: judge.model,
      synth: synth.model,
      minPanelSuccess: 2,
    });
    await expect(fusion.doGenerate(opts())).rejects.toThrow("only 1/2");
    expect(judge.calls).toHaveLength(0);
    expect(synth.calls).toHaveLength(0);
  });

  it("passthrough returns the lone survivor verbatim when below minPanelSuccess", async () => {
    const judge = judgeModel(sample);
    const synth = genModel("final");
    const fusion = createFusion({
      panel: [genModel("lone survivor").model, failGen("b")],
      judge: judge.model,
      synth: synth.model,
      minPanelSuccess: 2,
      onInsufficientPanel: "passthrough",
    });

    const result = await fusion.doGenerate(opts());
    const meta = result.providerMetadata?.fusion as Record<string, any>;

    expect(textOfContent(result.content)).toBe("lone survivor");
    expect(meta.degraded).toBe("single-survivor-passthrough");
    expect(meta.synthSource).toBe("passthrough");
    expect(judge.calls).toHaveLength(0);
    expect(synth.calls).toHaveLength(0);
  });

  it("does not count an empty-text answer as a survivor", async () => {
    const empty = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "   " }],
        finishReason,
        usage,
        warnings: [],
      }),
    });
    const fusion = createFusion({
      panel: [empty, failGen("b")],
      judge: judgeModel(sample).model,
      synth: genModel("final").model,
    });
    await expect(fusion.doGenerate(opts())).rejects.toThrow(
      "all panel members failed"
    );
  });
});

// ---------------------------------------------------------------------------
// Judge robustness
// ---------------------------------------------------------------------------
describe("createFusion — judge robustness", () => {
  it("parses a fenced ```json block", async () => {
    const judge = genModel(`\`\`\`json\n${JSON.stringify(sample)}\n\`\`\``);
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judge.model,
      synth: genModel("final").model,
    });
    const result = await fusion.doGenerate(opts());
    const meta = result.providerMetadata?.fusion as Record<string, any>;
    expect(meta.analysis).toEqual(sample);
    expect(meta.degraded).toBeNull();
  });

  it("parses JSON embedded in surrounding prose", async () => {
    const judge = genModel(
      `Here is the analysis: ${JSON.stringify(sample)} done.`
    );
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judge.model,
      synth: genModel("final").model,
    });
    const result = await fusion.doGenerate(opts());
    expect((result.providerMetadata?.fusion as any).analysis).toEqual(sample);
  });

  it("degrades gracefully on unparseable judge output", async () => {
    const events: FusionEvent["type"][] = [];
    const synth = genModel("reconciled answer");
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: genModel("total nonsense, no json here").model,
      synth: synth.model,
      onEvent: (e) => events.push(e.type),
    });

    const result = await fusion.doGenerate(opts());
    const meta = result.providerMetadata?.fusion as Record<string, any>;

    expect(textOfContent(result.content)).toBe("reconciled answer");
    expect(meta.degraded).toBe("judge-malformed");
    expect(events).toContain("judge:malformed");
    expect(result.warnings?.some((w) => w.type === "other")).toBe(true);
    // synth received the degraded prompt containing raw answers
    expect(JSON.stringify(synth.calls[0].prompt)).toContain("reconcile");
  });

  it("degrades when the judge throws", async () => {
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: failGen("judge down"),
      synth: genModel("reconciled").model,
    });
    const result = await fusion.doGenerate(opts());
    const meta = result.providerMetadata?.fusion as Record<string, any>;
    expect(textOfContent(result.content)).toBe("reconciled");
    expect(meta.degraded).toBe("judge-failed");
  });
});

// ---------------------------------------------------------------------------
// Synth fallback ladder
// ---------------------------------------------------------------------------
describe("createFusion — synth fallback", () => {
  it("falls back to the judge model when synth fails", async () => {
    const judge = judgeModel(sample); // also serves as synth fallback
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judge.model,
      synth: failGen("synth down"),
    });
    const result = await fusion.doGenerate(opts());
    const meta = result.providerMetadata?.fusion as Record<string, any>;
    expect(meta.synthSource).toBe("judge-fallback");
  });

  it("rejects when synth and every fallback fail", async () => {
    // Panel members answer once (as panel) then throw if reused as a synth fallback.
    const flaky = (text: string) => {
      let used = false;
      return new MockLanguageModelV4({
        doGenerate: () => {
          if (used) {
            return Promise.reject(new Error("no second use"));
          }
          used = true;
          return Promise.resolve({
            content: [{ type: "text", text }],
            finishReason,
            usage,
            warnings: [],
          });
        },
      });
    };
    const fusion = createFusion({
      panel: [flaky("a"), flaky("b")],
      judge: failGen("judge down"),
      synth: failGen("synth down"),
    });
    // judge degrades; synth + ladder (judge model, panel[0]) all throw -> reject
    await expect(fusion.doGenerate(opts())).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// doStream
// ---------------------------------------------------------------------------
describe("createFusion — doStream", () => {
  it("buffers panel + judge and streams only the synth answer", async () => {
    const a = genModel("a");
    const judge = judgeModel(sample);
    const synth = streamModel(["Hel", "lo, ", "world"]);
    const fusion = createFusion({
      panel: [a.model, genModel("b").model],
      judge: judge.model,
      synth: synth.model,
    });

    const { stream } = await fusion.doStream(opts());
    const parts = await collectParts(stream);

    expect(streamText(parts)).toBe("Hello, world");
    expect(a.calls).toHaveLength(1); // panel buffered via doGenerate
    expect(judge.calls).toHaveLength(1);
    expect(synth.calls).toHaveLength(1); // synth via doStream
  });

  it("emits exactly one stream-start first and one finish last", async () => {
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: streamModel(["hi"]).model,
    });
    const { stream } = await fusion.doStream(opts());
    const parts = await collectParts(stream);

    expect(parts.filter((p) => p.type === "stream-start")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "finish")).toHaveLength(1);
    expect(parts[0].type).toBe("stream-start");
    expect(parts.at(-1)?.type).toBe("finish");
  });

  it("'reasoning' emits the analysis block before the answer text", async () => {
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: streamModel(["answer"]).model,
      includeAnalysis: "reasoning",
    });
    const { stream } = await fusion.doStream(opts());
    const parts = await collectParts(stream);

    const firstReasoning = parts.findIndex((p) => p.type === "reasoning-start");
    const firstText = parts.findIndex((p) => p.type === "text-delta");
    expect(firstReasoning).toBeGreaterThanOrEqual(0);
    expect(firstReasoning).toBeLessThan(firstText);
    expect(streamText(parts)).toBe("answer");
  });

  it("carries aggregated usage and synth finishReason on the terminal finish", async () => {
    const fusion = createFusion({
      panel: [genModel("a", usageOf(1)).model, genModel("b", usageOf(2)).model],
      judge: judgeModel(sample, usageOf(3)).model,
      synth: streamModel(["x"], usageOf(4)).model,
    });
    const { stream } = await fusion.doStream(opts());
    const parts = await collectParts(stream);
    const finish = parts.find((p) => p.type === "finish") as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;

    expect(finish.usage.inputTokens.total).toBe(1 + 2 + 3 + 4);
    expect(finish.finishReason.unified).toBe("stop");
    expect((finish.providerMetadata?.fusion as any).analysis).toEqual(sample);
  });

  it("rejects the promise (no stream) when the panel gate fails", async () => {
    const fusion = createFusion({
      panel: [failGen("a"), failGen("b")],
      judge: judgeModel(sample).model,
      synth: streamModel(["x"]).model,
    });
    await expect(fusion.doStream(opts())).rejects.toThrow(
      "all panel members failed"
    );
  });

  it("converts a mid-stream synth error into error + terminal finish", async () => {
    const errorSynth = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "s1" },
            { type: "text-delta", id: "s1", delta: "partial" },
            { type: "error", error: new Error("synth blew up") },
            { type: "finish", finishReason, usage },
          ],
        }),
      }),
    });
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: errorSynth,
    });

    const { stream } = await fusion.doStream(opts());
    const parts = await collectParts(stream);

    const errIdx = parts.findIndex((p) => p.type === "error");
    const finishIdx = parts.findIndex((p) => p.type === "finish");
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(finishIdx).toBe(parts.length - 1); // finish is terminal, nothing after
    expect(errIdx).toBeLessThan(finishIdx);
    const finish = parts[finishIdx] as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;
    expect(finish.finishReason.unified).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Recursion guard
// ---------------------------------------------------------------------------
describe("createFusion — recursion guard", () => {
  it("rejects when invoked beyond the max nesting depth", async () => {
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
    });
    await expect(
      fusion.doGenerate({
        ...opts(),
        providerOptions: { aiRouterFusion: { depth: 1, ancestry: [] } },
      })
    ).rejects.toThrow("max nesting depth");
  });

  it("forwards the guard marker to child calls", async () => {
    const a = genModel("a");
    const fusion = createFusion({
      panel: [a.model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: genModel("final").model,
    });
    await fusion.doGenerate(opts());
    const guard = a.calls[0].providerOptions?.aiRouterFusion as {
      depth: number;
      ancestry: string[];
    };
    expect(guard.depth).toBe(1);
    expect(guard.ancestry).toHaveLength(1);
  });

  it("bounds indirect nesting (router -> inner fusion) without infinite recursion", async () => {
    const inner = createFusion({
      panel: [genModel("i1").model, genModel("i2").model],
    });
    const errors: string[] = [];
    const fusion = createFusion({
      panel: [
        {
          model: {
            fallback: [
              { provider: () => inner, model: "inner", supports: ["text"] },
            ],
          },
          label: "nested",
        },
        genModel("outer ok").model,
      ],
      onError: (i) => {
        if (i.error instanceof Error) {
          errors.push(i.error.message);
        }
      },
    });

    const result = await fusion.doGenerate(opts());
    expect(errors.some((m) => m.includes("max nesting depth"))).toBe(true);
    expect((result.providerMetadata?.fusion as any).panel.survived).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Observability & concurrency
// ---------------------------------------------------------------------------
describe("createFusion — observability", () => {
  it("emits lifecycle events in pipeline order", async () => {
    const events: FusionEvent[] = [];
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: genModel("final").model,
      onEvent: (e) => events.push(e),
    });
    await fusion.doGenerate(opts());

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("panel:selected");
    // exactly one start + one terminal per panel member
    expect(types.filter((t) => t === "panel:start")).toHaveLength(2);
    expect(
      types.filter((t) => t === "panel:success" || t === "panel:error")
    ).toHaveLength(2);
    // panel:selected precedes every panel:start
    expect(types.indexOf("panel:start")).toBeGreaterThan(
      types.indexOf("panel:selected")
    );
    const lastSuccess = types.lastIndexOf("panel:success");
    expect(types.indexOf("judge:start")).toBeGreaterThan(lastSuccess);
    expect(types.indexOf("synth:start")).toBeGreaterThan(
      types.indexOf("judge:done")
    );
    expect(types.at(-1)).toBe("synth:done");
  });

  it("honors a concurrency limit while still running every member", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const make = (text: string) =>
      new MockLanguageModelV4({
        doGenerate: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight--;
          return {
            content: [{ type: "text", text }],
            finishReason,
            usage,
            warnings: [],
          };
        },
      });
    const fusion = createFusion({
      panel: [make("a"), make("b"), make("c")],
      judge: judgeModel(sample).model,
      synth: genModel("final").model,
      concurrency: 1,
    });

    const result = await fusion.doGenerate(opts());
    expect(maxInFlight).toBe(1);
    expect((result.providerMetadata?.fusion as any).panel.survived).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Composition with the AI SDK + router
// ---------------------------------------------------------------------------
describe("createFusion — composition", () => {
  it("works end-to-end through generateText", async () => {
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: genModel("FINAL").model,
    });
    const { text } = await generateText({ model: fusion, prompt: "hi" });
    expect(text).toBe("FINAL");
  });

  it("works as a candidate inside createRouter", async () => {
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: genModel("ROUTED").model,
    });
    const route = createRouter({
      models: {
        smart: [
          { provider: () => fusion, model: "fusion", supports: ["text"] },
        ],
      },
    });
    const { text } = await generateText({
      model: route("smart"),
      prompt: "hi",
    });
    expect(text).toBe("ROUTED");
  });
});

// ---------------------------------------------------------------------------
// Review hardening — robustness & contract details surfaced by the review
// ---------------------------------------------------------------------------

const partialUsage = (
  inTotal: number,
  outTotal: number,
  cacheRead?: number
): LanguageModelV4Usage => ({
  inputTokens: {
    total: inTotal,
    noCache: undefined,
    cacheRead,
    cacheWrite: undefined,
  },
  outputTokens: { total: outTotal, text: undefined, reasoning: undefined },
});

/** A model that records calls and returns a different text on each successive call. */
function sequenceModel(...texts: string[]) {
  const calls: Gen[] = [];
  let i = 0;
  const model = new MockLanguageModelV4({
    doGenerate: (o: Gen) => {
      calls.push(o);
      const text = texts[Math.min(i, texts.length - 1)];
      i++;
      return Promise.resolve({
        content: [{ type: "text", text }],
        finishReason,
        usage,
        warnings: [],
      });
    },
  });
  return { model, calls };
}

function rawStreamModel(rawValue: unknown) {
  const calls: Gen[] = [];
  const model = new MockLanguageModelV4({
    doStream: (o: Gen) => {
      calls.push(o);
      return Promise.resolve({
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "s1" },
            { type: "text-delta", id: "s1", delta: "hi" },
            { type: "raw", rawValue },
            { type: "text-end", id: "s1" },
            { type: "finish", finishReason, usage },
          ],
        }),
      });
    },
  });
  return { model, calls };
}

describe("createFusion — parse robustness", () => {
  it("does not crash on type-valid-but-wrong-shaped judge JSON (coerces fields)", async () => {
    const weird = {
      consensus: ["ok"],
      contradictions: [{ point: "p", positions: 5 }], // positions wrong type
      partialCoverage: [{ aspect: "a", coveredBy: "Model A", missingFrom: [] }], // coveredBy wrong type
      uniqueInsights: [],
      blindSpots: [],
      ranking: [],
      synthesisGuidance: "go",
    };
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: genModel(JSON.stringify(weird)).model,
      synth: genModel("FINAL").model,
      includeAnalysis: "reasoning",
    });
    const result = await fusion.doGenerate(opts());
    const meta = result.providerMetadata?.fusion as Record<string, any>;

    expect(result.content[0].type).toBe("reasoning"); // rendered without throwing
    expect(textOfContent(result.content)).toBe("FINAL");
    expect(meta.degraded).toBeNull(); // still a usable (coerced) analysis
    expect(meta.analysis.contradictions[0].positions).toEqual([]); // coerced from 5
    expect(meta.analysis.partialCoverage[0].coveredBy).toEqual([]); // coerced from 'Model A'
  });

  it("parses valid JSON even when trailing prose contains a brace", async () => {
    const judge = genModel(
      JSON.stringify(sample) +
        "\n\nHope this helps! Tweak the {weighting} if needed."
    );
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judge.model,
      synth: genModel("final").model,
    });
    const meta = (await fusion.doGenerate(opts())).providerMetadata
      ?.fusion as Record<string, any>;
    expect(meta.analysis).toEqual(sample);
    expect(meta.degraded).toBeNull();
  });

  it("parses JSON that follows a leading non-JSON code fence", async () => {
    const judge = genModel(
      `\`\`\`\nlet me think about this...\n\`\`\`\n${JSON.stringify(sample)}`
    );
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judge.model,
      synth: genModel("final").model,
    });
    const meta = (await fusion.doGenerate(opts())).providerMetadata
      ?.fusion as Record<string, any>;
    expect(meta.analysis).toEqual(sample);
  });

  it("ignores braces inside JSON string values when slicing", async () => {
    const tricky: FusionAnalysis = {
      ...sample,
      synthesisGuidance: "use a } brace and { another",
    };
    const judge = genModel(`${JSON.stringify(tricky)} trailing note.`);
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judge.model,
      synth: genModel("final").model,
    });
    const meta = (await fusion.doGenerate(opts())).providerMetadata
      ?.fusion as Record<string, any>;
    expect(meta.analysis.synthesisGuidance).toBe("use a } brace and { another");
  });
});

describe("createFusion — option forwarding & usage", () => {
  it("forwards abortSignal / headers / maxOutputTokens to every stage", async () => {
    const a = genModel("a");
    const judge = judgeModel(sample);
    const synth = genModel("final");
    const ac = new AbortController();
    const fusion = createFusion({
      panel: [a.model, genModel("b").model],
      judge: judge.model,
      synth: synth.model,
    });

    await fusion.doGenerate({
      ...opts(),
      abortSignal: ac.signal,
      headers: { "x-test": "1" },
      maxOutputTokens: 256,
    });

    expect(a.calls[0].abortSignal).toBe(ac.signal);
    expect(judge.calls[0].headers?.["x-test"]).toBe("1");
    expect(synth.calls[0].maxOutputTokens).toBe(256);
  });

  it("forwards the original (multimodal) prompt to panel verbatim; judge gets flattened text", async () => {
    const bare = genModel("bare");
    const judge = judgeModel(sample);
    const fusion = createFusion({
      panel: [bare.model, genModel("b").model],
      judge: judge.model,
      synth: genModel("final").model,
    });

    await fusion.doGenerate(opts(imagePrompt));

    expect(bare.calls[0].prompt).toEqual(imagePrompt); // panel sees the file part untouched
    expect(JSON.stringify(judge.calls[0].prompt)).toContain("[image]"); // judge sees a placeholder
    expect(JSON.stringify(judge.calls[0].prompt)).not.toContain(
      "example.com/image.png"
    );
  });

  it("preserves undefined usage fields instead of coercing them to 0", async () => {
    const fusion = createFusion({
      panel: [
        genModel("a", partialUsage(1, 2)).model,
        genModel("b", partialUsage(3, 4)).model,
      ],
      judge: judgeModel(sample, partialUsage(5, 6)).model,
      synth: genModel("final", partialUsage(7, 8)).model,
    });
    const r = await fusion.doGenerate(opts());
    expect(r.usage.inputTokens.total).toBe(1 + 3 + 5 + 7);
    expect(r.usage.outputTokens.total).toBe(2 + 4 + 6 + 8);
    expect(r.usage.inputTokens.cacheRead).toBeUndefined(); // all-undefined stays undefined, not 0
    expect(r.usage.outputTokens.text).toBeUndefined();
  });

  it("sums a defined usage field across a mix of defined/undefined contributors", async () => {
    const fusion = createFusion({
      panel: [
        genModel("a", partialUsage(1, 1, 10)).model, // cacheRead defined
        genModel("b", partialUsage(1, 1)).model, // cacheRead undefined
      ],
      judge: judgeModel(sample, partialUsage(1, 1)).model,
      synth: genModel("final", partialUsage(1, 1)).model,
    });
    const r = await fusion.doGenerate(opts());
    expect(r.usage.inputTokens.cacheRead).toBe(10); // defined + undefined => defined
  });
});

describe("createFusion — synth content & fallback (extended)", () => {
  it("forwards non-text synth content (source parts) in doGenerate", async () => {
    const synth = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "source",
            sourceType: "url",
            id: "src-1",
            url: "https://e.com",
            title: "E",
          },
          { type: "text", text: "FINAL" },
        ],
        finishReason,
        usage,
        warnings: [],
      }),
    });
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth,
    });
    const result = await fusion.doGenerate(opts());
    expect(result.content.some((c) => c.type === "source")).toBe(true);
    expect(textOfContent(result.content)).toBe("FINAL");
  });

  it("uses a panel member as the writer when synth and judge both fail (panel-fallback)", async () => {
    const a = sequenceModel("panel A", "synth from A"); // panel call, then synth call
    const fusion = createFusion({
      panel: [a.model, genModel("b").model],
      judge: failGen("judge down"),
      synth: failGen("synth down"),
    });
    const result = await fusion.doGenerate(opts());
    const meta = result.providerMetadata?.fusion as Record<string, any>;
    expect(meta.synthSource).toBe("panel-fallback");
    expect(textOfContent(result.content)).toBe("synth from A");
    expect(a.calls).toHaveLength(2); // answered as panel, then wrote as synth
  });
});

describe("createFusion — doStream (extended)", () => {
  it("drops raw chunks unless includeRawChunks is set, and forwards them when it is", async () => {
    const off = rawStreamModel({ foo: 1 });
    const fusionOff = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: off.model,
    });
    const partsOff = await collectParts(
      (await fusionOff.doStream(opts())).stream
    );
    expect(partsOff.some((p) => p.type === "raw")).toBe(false);

    const on = rawStreamModel({ foo: 1 });
    const fusionOn = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: on.model,
    });
    const partsOn = await collectParts(
      (await fusionOn.doStream({ ...opts(), includeRawChunks: true })).stream
    );
    expect(partsOn.some((p) => p.type === "raw")).toBe(true);
    expect(on.calls[0].includeRawChunks).toBe(true); // propagated to synth
  });

  it("merges synth stream-start warnings and degraded warnings onto the outer stream-start", async () => {
    const warnSynth = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          chunks: [
            {
              type: "stream-start",
              warnings: [{ type: "other", message: "synth-warn" }],
            },
            { type: "text-start", id: "s1" },
            { type: "text-delta", id: "s1", delta: "x" },
            { type: "text-end", id: "s1" },
            { type: "finish", finishReason, usage },
          ],
        }),
      }),
    });
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: failGen("judge down"), // degrade -> adds a 'judge stage failed' warning
      synth: warnSynth,
    });
    const parts = await collectParts((await fusion.doStream(opts())).stream);
    const start = parts[0] as Extract<
      LanguageModelV4StreamPart,
      { type: "stream-start" }
    >;
    const messages = start.warnings
      .filter(
        (w): w is Extract<SharedV4Warning, { type: "other" }> =>
          w.type === "other"
      )
      .map((w) => w.message);
    expect(messages).toContain("synth-warn");
    expect(messages.some((m) => m.includes("judge stage failed"))).toBe(true);
  });

  it("includeAnalysis:false on the stream omits metadata and reasoning", async () => {
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth: streamModel(["x"]).model,
      includeAnalysis: false,
    });
    const parts = await collectParts((await fusion.doStream(opts())).stream);
    const finish = parts.find((p) => p.type === "finish") as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;
    expect(finish.providerMetadata).toBeUndefined();
    expect(parts.some((p) => p.type === "reasoning-start")).toBe(false);
  });

  it("passthrough streams the lone survivor verbatim", async () => {
    const fusion = createFusion({
      panel: [genModel("lone survivor").model, failGen("b")],
      judge: judgeModel(sample).model,
      synth: genModel("unused").model,
      minPanelSuccess: 2,
      onInsufficientPanel: "passthrough",
    });
    const parts = await collectParts((await fusion.doStream(opts())).stream);
    expect(streamText(parts)).toBe("lone survivor");
    expect(parts[0].type).toBe("stream-start");
    expect(parts.at(-1)?.type).toBe("finish");
    const finish = parts.at(-1) as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;
    const meta = finish.providerMetadata?.fusion as Record<string, any>;
    expect(meta.synthSource).toBe("passthrough");
    expect(meta.degraded).toBe("single-survivor-passthrough");
  });

  it("passes source parts through untouched and drops synth response-metadata", async () => {
    const synth = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "resp-1", modelId: "synth-model" },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "hello" },
            {
              type: "source",
              sourceType: "url",
              id: "src-1",
              url: "https://e.com",
              title: "E",
            },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason, usage },
          ],
        }),
      }),
    });
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth,
    });
    const parts = await collectParts((await fusion.doStream(opts())).stream);

    expect(parts.some((p) => p.type === "response-metadata")).toBe(false); // dropped
    const source = parts.find((p) => p.type === "source") as Extract<
      LanguageModelV4StreamPart,
      { type: "source" }
    >;
    expect(source.id).toBe("src-1"); // semantic id NOT namespaced
    const textStart = parts.find((p) => p.type === "text-start") as Extract<
      LanguageModelV4StreamPart,
      { type: "text-start" }
    >;
    expect(textStart.id).toBe("synth:t1"); // grouping id IS namespaced
  });

  it("streams via the judge model when the synth stream fails (judge-fallback)", async () => {
    const judge = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify(sample) }],
        finishReason,
        usage,
        warnings: [],
      }),
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "j1" },
            { type: "text-delta", id: "j1", delta: "JUDGE WRITES" },
            { type: "text-end", id: "j1" },
            { type: "finish", finishReason, usage },
          ],
        }),
      }),
    });
    const synthFail = new MockLanguageModelV4({
      doStream: () => Promise.reject(new Error("synth stream down")),
    });
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge,
      synth: synthFail,
    });
    const parts = await collectParts((await fusion.doStream(opts())).stream);
    expect(streamText(parts)).toBe("JUDGE WRITES");
    const finish = parts.at(-1) as Extract<
      LanguageModelV4StreamPart,
      { type: "finish" }
    >;
    expect(
      (finish.providerMetadata?.fusion as Record<string, any>).synthSource
    ).toBe("judge-fallback");
  });

  it("cancelling the fused stream cancels the synth substream", async () => {
    let cancelled = false;
    const synth = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "s1" });
            controller.enqueue({
              type: "text-delta",
              id: "s1",
              delta: "partial",
            });
            // intentionally never closes; relies on consumer cancel
          },
          cancel() {
            cancelled = true;
          },
        }),
      }),
    });
    const fusion = createFusion({
      panel: [genModel("a").model, genModel("b").model],
      judge: judgeModel(sample).model,
      synth,
    });
    const { stream } = await fusion.doStream(opts());
    const reader = stream.getReader();
    await reader.read(); // stream-start
    await reader.read(); // first forwarded part
    await reader.cancel(); // consumer aborts
    // allow the generator's finally to run
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });
});

describe("createFusion — concurrency ordering & duplicate labels", () => {
  it("preserves declaration order in labels despite out-of-order completion", async () => {
    let releaseA: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      releaseA = r;
    });
    const slowA = new MockLanguageModelV4({
      doGenerate: async () => {
        await gate; // A finishes last
        return {
          content: [{ type: "text", text: "A" }],
          finishReason,
          usage,
          warnings: [],
        };
      },
    });
    const judge = judgeModel(sample);
    const fusion = createFusion({
      panel: [slowA, genModel("B").model, genModel("C").model],
      judge: judge.model,
      synth: genModel("final").model,
      concurrency: 3,
    });

    const p = fusion.doGenerate(opts());
    await Promise.resolve(); // let B and C settle first
    releaseA();
    const result = await p;

    expect((result.providerMetadata?.fusion as any).panel.labels).toEqual([
      "Model A",
      "Model B",
      "Model C",
    ]);
    const judgePrompt = JSON.stringify(judge.calls[0].prompt);
    expect(judgePrompt.indexOf("Model A")).toBeLessThan(
      judgePrompt.indexOf("Model C")
    );
  });

  it("throws on duplicate panel labels", () => {
    expect(() =>
      createFusion({
        panel: [
          { model: genModel("a").model, label: "Model B" },
          genModel("b").model,
        ],
      })
    ).toThrow("duplicate panel label");
  });
});
