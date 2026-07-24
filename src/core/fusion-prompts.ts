import type { JSONSchema7, LanguageModelV4Prompt } from "@ai-sdk/provider";

/**
 * Structured comparison the judge produces from the panel answers. It compares
 * — it does not merge. The synth stage turns this into the final answer.
 */
export interface FusionAnalysis {
  /** Important aspects the question needed that NO answer covered. */
  blindSpots: string[];
  /** Claims (near-)all panel answers agree on — the high-confidence core. */
  consensus: string[];
  /** Direct disagreements: a point plus who holds which position. */
  contradictions: Array<{
    point: string;
    positions: Array<{ label: string; claim: string }>;
  }>;
  /** Sub-topics some answers addressed and others omitted. */
  partialCoverage: Array<{
    aspect: string;
    coveredBy: string[];
    missingFrom: string[];
  }>;
  /** Judge's trust ranking, best first, with a one-line reason. */
  ranking: Array<{ label: string; reason: string }>;
  /** 1-3 sentence directive to the synth writer. */
  synthesisGuidance: string;
  /** Correct, valuable points raised by exactly one answer. */
  uniqueInsights: Array<{ label: string; insight: string }>;
}

/**
 * Internal pipeline shape: a {@link FusionAnalysis} plus the parser's
 * `_malformed` flag, set when the judge's JSON was unusable (degraded path).
 * The flag is never requested from the model and is stripped before the analysis
 * reaches the public surface (`providerMetadata.fusion.analysis` / events).
 */
export type ParsedAnalysis = FusionAnalysis & { _malformed?: boolean };

/**
 * JSON schema handed to the judge via `responseFormat: { type: 'json', schema }`.
 * Mirrors {@link FusionAnalysis} (minus the internal `_malformed` flag). Written
 * by hand — the package has no zod dependency.
 */
export const ANALYSIS_JSON_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: [
    "consensus",
    "contradictions",
    "partialCoverage",
    "uniqueInsights",
    "blindSpots",
    "ranking",
    "synthesisGuidance",
  ],
  properties: {
    consensus: { type: "array", items: { type: "string" } },
    contradictions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["point", "positions"],
        properties: {
          point: { type: "string" },
          positions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "claim"],
              properties: {
                label: { type: "string" },
                claim: { type: "string" },
              },
            },
          },
        },
      },
    },
    partialCoverage: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["aspect", "coveredBy", "missingFrom"],
        properties: {
          aspect: { type: "string" },
          coveredBy: { type: "array", items: { type: "string" } },
          missingFrom: { type: "array", items: { type: "string" } },
        },
      },
    },
    uniqueInsights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "insight"],
        properties: { label: { type: "string" }, insight: { type: "string" } },
      },
    },
    blindSpots: { type: "array", items: { type: "string" } },
    ranking: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "reason"],
        properties: { label: { type: "string" }, reason: { type: "string" } },
      },
    },
    synthesisGuidance: { type: "string" },
  },
};

const JUDGE_SYSTEM = `You are the JUDGE in a multi-model answer-fusion pipeline. Several independent AI models were given the SAME user request and produced the answers below. Your job is to COMPARE them rigorously — NOT to merge them, NOT to write a new answer, and NOT to pick a single winner verbatim.

Return ONLY a single JSON object, no prose and no markdown fences, with this exact shape:

{
  "consensus":        [ "claim that most/all answers agree on", ... ],
  "contradictions":   [ { "point": "...", "positions": [ { "label": "Model A", "claim": "..." } ] } ],
  "partialCoverage":  [ { "aspect": "...", "coveredBy": ["Model A"], "missingFrom": ["Model B"] } ],
  "uniqueInsights":   [ { "label": "Model B", "insight": "a correct idea only this answer had" } ],
  "blindSpots":       [ "something EVERY answer missed or got wrong", ... ],
  "ranking":          [ { "label": "Model A", "reason": "one line on why it ranks here" } ],
  "synthesisGuidance":"1-3 sentences telling the writer what to keep, drop, and caveat"
}

Rules:
- Judge on CORRECTNESS and EVIDENCE, not verbosity or confident tone.
- A claim made by only one model is NOT consensus.
- If two answers conflict on a fact, record it under "contradictions" with each side's "claim" — do not silently average them.
- "uniqueInsights" must be points you judge CORRECT, not merely different.
- "blindSpots" is the panel's COLLECTIVE gap — be specific, not "could be more detailed".
- "synthesisGuidance" is your most important field: it steers the final answer.
- Reference candidates ONLY by their label (e.g. "Model A"). Use [] for empty categories.
- Output JSON only.`;

const SYNTH_SYSTEM = `You are the SYNTHESIZER, the final author in a multi-model fusion pipeline. A panel of models answered the user's request, and a judge compared them into the structured analysis below. Write the SINGLE BEST answer to the user's ORIGINAL request.

How to use the analysis:
- Build the answer on the "consensus" — that is the high-confidence core. State it plainly.
- Fold in "uniqueInsights" where they strengthen the answer.
- For each "contradictions" item, take the better-supported position; if it is genuinely unresolved, say so briefly and explain the trade-off — do not fake certainty.
- Cover the aspects in "partialCoverage" so the answer is more complete than any single input.
- Address the "blindSpots" if you legitimately can; otherwise flag them as open questions.
- Follow "synthesisGuidance" — it is the judge's direct instruction to you.

Write for the USER, not about the models. NEVER mention "the panel", "the judge", "Model A/B/C", "the analysis", or that fusion happened. Produce a clean, self-contained answer in the format the original request asked for. Be decisive; hedge only on the genuine uncertainties the analysis identified.`;

const SYNTH_DEGRADED_SYSTEM = `You are the SYNTHESIZER, the final author in a multi-model fusion pipeline. A panel of models answered the user's request. The comparison step was unavailable, so you are given the raw candidate answers and must reconcile them yourself. Write the SINGLE BEST answer to the user's ORIGINAL request.

How to reconcile:
- Keep what the answers agree on; treat that as the high-confidence core.
- Where they conflict, take the better-supported position; if genuinely unresolved, say so briefly.
- Keep valuable points that only one answer raised, if they are correct.

Write for the USER, not about the models. NEVER mention "the panel", "the candidates", "Model A/B/C", or that fusion happened. Produce a clean, self-contained answer in the format the original request asked for.`;

/** A panel answer as presented to the judge / degraded synth. */
export interface LabeledAnswer {
  label: string;
  text: string;
}

/** Truncate long rendered values so a single part can't blow up the prompt. */
const cap = (s: string, max = 600): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

/** Best-effort JSON rendering; never throws. */
function jsonish(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Render a tool-result output union into a readable string. */
function renderToolOutput(output: {
  type: string;
  value?: unknown;
  reason?: string;
}): string {
  if (output.type === "text") {
    return String(output.value ?? "");
  }
  if (output.type === "json") {
    return jsonish(output.value);
  }
  if (output.type === "execution-denied") {
    return `execution denied${output.reason ? `: ${output.reason}` : ""}`;
  }
  return jsonish(output.value ?? output.type);
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Map a media type to a short placeholder tag (no nested ternaries). */
function mediaTag(mediaType: string): string {
  const mt = mediaType.toLowerCase();
  if (mt.includes("pdf")) {
    return "pdf";
  }
  if (mt.startsWith("image")) {
    return "image";
  }
  if (mt.startsWith("audio")) {
    return "audio";
  }
  if (mt.startsWith("video")) {
    return "video";
  }
  return "file";
}

const ROLE_LABEL: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
};

/** Drop the internal `_malformed` flag, returning only the public analysis fields. */
export function stripInternal(a: ParsedAnalysis): FusionAnalysis {
  return {
    consensus: a.consensus,
    contradictions: a.contradictions,
    partialCoverage: a.partialCoverage,
    uniqueInsights: a.uniqueInsights,
    blindSpots: a.blindSpots,
    ranking: a.ranking,
    synthesisGuidance: a.synthesisGuidance,
  };
}

/**
 * Flatten a model-level prompt into plain text for the judge/synth stages.
 * Non-text file parts become `[image]`/`[pdf]`/`[audio]`/`[video]` placeholders
 * (these stages are text-only; the multimodal parts already reached the panel).
 */
export function renderOriginal(prompt: LanguageModelV4Prompt): string {
  const blocks: string[] = [];

  for (const message of prompt) {
    if (message.role === "system") {
      blocks.push(`System: ${message.content}`);
      continue;
    }

    const parts: string[] = [];
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          parts.push(part.text);
          break;
        case "file":
          parts.push(`[${mediaTag(part.mediaType ?? "")}]`);
          break;
        case "tool-call":
          parts.push(
            `[tool-call ${part.toolName}(${cap(jsonish(part.input))})]`
          );
          break;
        case "tool-result":
          parts.push(
            `[tool-result ${part.toolName}: ${cap(renderToolOutput(part.output))}]`
          );
          break;
        case "tool-approval-response":
          parts.push(
            `[tool-approval ${part.approved ? "granted" : "denied"}${part.reason ? `: ${part.reason}` : ""}]`
          );
          break;
        // reasoning / reasoning-file / custom: skip.
        default:
          break;
      }
    }

    const text = parts.join("\n").trim();
    if (!text) {
      continue;
    }
    blocks.push(`${ROLE_LABEL[message.role] ?? "Tool"}: ${text}`);
  }

  return blocks.join("\n\n");
}

/** Two-message judge prompt: system rubric + assembled candidate answers. */
export function buildJudgePrompt(
  original: string,
  answers: LabeledAnswer[]
): LanguageModelV4Prompt {
  const candidates = answers
    .map((a) => `### ${a.label}\n${a.text}`)
    .join("\n\n");

  const user = `## Original user request
${original}

## Candidate answers

${candidates}

Compare these answers and return ONLY the JSON analysis described in your instructions.`;

  return [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: [{ type: "text", text: user }] },
  ];
}

/** Two-message synth prompt for the normal path (judge analysis available). */
export function buildSynthPrompt(
  original: string,
  analysis: ParsedAnalysis
): LanguageModelV4Prompt {
  const user = `## Original user request
${original}

## Judge's analysis
${JSON.stringify(stripInternal(analysis), null, 2)}

Now write the final answer to the original request.`;

  return [
    { role: "system", content: SYNTH_SYSTEM },
    { role: "user", content: [{ type: "text", text: user }] },
  ];
}

/**
 * Degraded synth prompt used when the judge failed or returned unusable JSON:
 * the synth reconciles the raw candidate answers itself.
 */
export function buildDegradedSynthPrompt(
  original: string,
  answers: LabeledAnswer[],
  guidance?: string
): LanguageModelV4Prompt {
  const candidates = answers
    .map((a) => `### ${a.label}\n${a.text}`)
    .join("\n\n");

  const notes = guidance?.trim() ? `\n## Notes\n${guidance.trim()}\n` : "";

  const user = `## Original user request
${original}

## Candidate answers (the comparison step was unavailable; reconcile them yourself)

${candidates}
${notes}
Write the single best final answer now: reconcile agreements, resolve conflicts toward the best-supported position, and keep valuable unique points.`;

  return [
    { role: "system", content: SYNTH_DEGRADED_SYSTEM },
    { role: "user", content: [{ type: "text", text: user }] },
  ];
}

function bulletSection(title: string, items: unknown): string {
  const arr = asArray<unknown>(items);
  const body = arr.length
    ? arr.map((i) => `- ${String(i)}`).join("\n")
    : "- (none)";
  return `## ${title}\n${body}`;
}

function labeledSection(
  title: string,
  items: unknown,
  fmt: (item: Record<string, unknown>) => string
): string {
  const arr = asArray<Record<string, unknown>>(items);
  const body = arr.length ? arr.map(fmt).join("\n") : "- (none)";
  return `## ${title}\n${body}`;
}

function contradictionsSection(items: unknown): string {
  const arr = asArray<{ point?: unknown; positions?: unknown }>(items);
  if (arr.length === 0) {
    return "## Contradictions\n- (none)";
  }
  const body = arr
    .map((c) => {
      const head = `- ${String(c.point ?? "")}`;
      const pos = asArray<{ label?: unknown; claim?: unknown }>(c.positions)
        .map((p) => `  - ${String(p.label ?? "")}: ${String(p.claim ?? "")}`)
        .join("\n");
      return pos ? `${head}\n${pos}` : head;
    })
    .join("\n");
  return `## Contradictions\n${body}`;
}

function partialCoverageSection(items: unknown): string {
  const arr = asArray<{
    aspect?: unknown;
    coveredBy?: unknown;
    missingFrom?: unknown;
  }>(items);
  if (arr.length === 0) {
    return "## Partial coverage\n- (none)";
  }
  const body = arr
    .map(
      (p) =>
        `- ${String(p.aspect ?? "")} — covered by ${asArray<string>(p.coveredBy).join(", ") || "(none)"}; missing from ${asArray<string>(p.missingFrom).join(", ") || "(none)"}`
    )
    .join("\n");
  return `## Partial coverage\n${body}`;
}

/**
 * Human-readable rendering of the analysis, used for `includeAnalysis: 'reasoning'`.
 * Defensive against wrong-typed fields — a judge that returns the right keys with
 * the wrong value types must never crash the render path.
 */
export function renderAnalysisMarkdown(analysis: ParsedAnalysis): string {
  if (analysis._malformed) {
    return `# Fusion analysis (degraded)\n\nThe comparison step did not return structured output. Raw notes:\n\n${analysis.synthesisGuidance || "(none)"}`;
  }
  return [
    "# Fusion analysis",
    bulletSection("Consensus", analysis.consensus),
    contradictionsSection(analysis.contradictions),
    partialCoverageSection(analysis.partialCoverage),
    labeledSection(
      "Unique insights",
      analysis.uniqueInsights,
      (u) => `- ${String(u.label ?? "")}: ${String(u.insight ?? "")}`
    ),
    bulletSection("Blind spots", analysis.blindSpots),
    labeledSection(
      "Ranking",
      analysis.ranking,
      (r) => `- ${String(r.label ?? "")}: ${String(r.reason ?? "")}`
    ),
    `## Synthesis guidance\n${analysis.synthesisGuidance || "(none)"}`,
  ].join("\n\n");
}
