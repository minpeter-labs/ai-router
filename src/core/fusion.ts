import type {
  JSONObject,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider";
import {
  ANALYSIS_JSON_SCHEMA,
  buildDegradedSynthPrompt,
  buildJudgePrompt,
  buildSynthPrompt,
  type FusionAnalysis,
  type LabeledAnswer,
  type ParsedAnalysis,
  renderAnalysisMarkdown,
  renderOriginal,
  stripInternal,
} from "./fusion-prompts";
import { detectModalities, supportsAll } from "./modality";
import { createRouter } from "./router";
import type { Modality, ProviderEntry } from "./types";

export type { FusionAnalysis } from "./fusion-prompts";

/** Reasoning effort, mirroring `LanguageModelV4CallOptions['reasoning']`. */
type ReasoningEffort = LanguageModelV4CallOptions["reasoning"];

/**
 * A model that participates in a fusion stage. Two forms:
 *  - A bare AI SDK `LanguageModel` object (the common case).
 *  - `{ fallback: ProviderEntry[] }`: wrapped internally in the same
 *    `RouterLanguageModel` `createRouter` builds, so this slot gets ordered
 *    fallback + per-entry modality filtering for free.
 *
 * A bare member must be a `LanguageModelV4` object (what `createOpenRouter()(id)`,
 * `createFriendli()(id)`, etc. return) — not a bare model-id string.
 */
export type FusionMember = LanguageModelV4 | { fallback: ProviderEntry[] };

/** A panel member with optional per-member presentation/sampling overrides. */
export interface FusionMemberConfig {
  /** Human label shown to the judge ("Model A") and surfaced in the analysis. Auto-assigned A, B, C… if omitted. */
  label?: string;
  /** The model (bare or fallback list). */
  model: FusionMember;
  /**
   * Declared input modalities for a BARE-model member, used for filtering.
   * Ignored for `{ fallback }` members (they filter via their own entries'
   * `supports`). A bare member with no `supports` is opaque and never dropped.
   */
  supports?: Modality[];
  /** Per-member panel temperature. Overrides `panelTemperature`. */
  temperature?: number;
}

/** An item in the panel: a bare member, a fallback member, or a config wrapper. */
export type FusionPanelItem = FusionMember | FusionMemberConfig;

/** Which model produced the final answer. */
export type FusionSynthSource =
  | "synth"
  | "judge-fallback"
  | "panel-fallback"
  | "passthrough";

/** Per-stage error hook, mirroring the router's `onError` ethos. Must not throw. */
export type OnFusionError = (info: {
  stage: "panel" | "judge" | "synth";
  /** Panel member label, or the synth-source label for the synth stage. */
  label: string;
  /** Panel member index (0-based); -1 for judge/synth. */
  index: number;
  error: unknown;
}) => void;

/** Lifecycle event for tracing a full fusion run. Handler errors are swallowed. */
export type FusionEvent =
  | {
      type: "panel:selected";
      labels: string[];
      dropped: { label: string; reason: string }[];
    }
  | { type: "panel:start"; label: string }
  | {
      type: "panel:success";
      label: string;
      text: string;
      usage: LanguageModelV4Usage;
    }
  | { type: "panel:error"; label: string; error: unknown }
  | { type: "judge:start" }
  | {
      type: "judge:done";
      analysis: FusionAnalysis;
      usage: LanguageModelV4Usage;
    }
  | { type: "judge:malformed"; raw: string }
  | { type: "judge:error"; error: unknown }
  | { type: "synth:start" }
  | { type: "synth:done"; usage: LanguageModelV4Usage };

export interface FusionOptions {
  /** Max panel calls in flight at once. Default `Infinity` (full parallelism). */
  concurrency?: number;

  /**
   * Surface the judge's analysis to the caller.
   *  - `'metadata'` (default): structured analysis under `providerMetadata.fusion`; answer text unchanged.
   *  - `'reasoning'` | `true`: also emit a human-readable analysis as a reasoning block before the answer.
   *  - `false`: final answer only; no `providerMetadata.fusion`.
   */
  includeAnalysis?: boolean | "metadata" | "reasoning";

  /** Model that compares panel answers into structured analysis. Default: first surviving panel member. */
  judge?: FusionMember;
  /** Sampling temperature for the judge. Default `0` (analysis must be stable). */
  judgeTemperature?: number;

  /** Minimum non-empty panel answers required to proceed to the judge. Default `1`. */
  minPanelSuccess?: number;

  /**
   * What to do when the prompt carries modalities a panel member can't handle.
   *  - `'filter'` (default): drop members that can't cover them; keep the rest. Bare
   *    members with no declared `supports` are opaque and never dropped.
   *  - `'error'`: throw if any declared member can't handle the prompt.
   */
  modalityBehavior?: "filter" | "error";
  /** Reported as `model.modelId`. Default `'fusion'`. */
  modelId?: string;
  /** Per-stage error hook (logging/metrics). Must not throw. */
  onError?: OnFusionError;
  /** Live lifecycle callback for debugging a fusion run. Thrown errors are swallowed. */
  onEvent?: (event: FusionEvent) => void;
  /**
   * Behavior when surviving (non-empty) panel answers are below `minPanelSuccess`:
   *  - `'error'` (default): reject the request.
   *  - `'passthrough'`: if EXACTLY one survived, skip judge+synth and return that
   *    answer verbatim (annotated `degraded`). Zero survivors always errors.
   */
  onInsufficientPanel?: "error" | "passthrough";
  /** Panel: 2+ members that each answer the original prompt in parallel. */
  panel: FusionPanelItem[];

  /** Sampling temperature for panel calls. Default `0.7` (diversity is the point). */
  panelTemperature?: number;

  /** Reported as `model.provider`. Default `'fusion'`. */
  providerId?: string;
  /** Reasoning effort applied to all stages unless the caller's call options set one. */
  reasoning?: ReasoningEffort;
  /** Model that writes the final answer from the analysis. Default: the resolved judge. */
  synth?: FusionMember;
  /** Sampling temperature for synth. Default: the caller's request `temperature`, else `0.3`. */
  synthTemperature?: number;
}

/** Default maximum fusion nesting depth (1 — no nested fusion). */
export const MAX_FUSION_DEPTH = 1;

/** `providerOptions` namespace carrying the recursion guard across call boundaries. */
const GUARD_NS = "aiRouterFusion";

/** Registry of fusion instances, for the construction-time direct-self-reference check. */
const FUSION_INSTANCES = new WeakSet<object>();

const isFusionModel = (m: unknown): boolean =>
  typeof m === "object" && m !== null && FUSION_INSTANCES.has(m);

// ---------------------------------------------------------------------------
// Usage aggregation (exact V4 shape, undefined-preserving)
// ---------------------------------------------------------------------------
const EMPTY_USAGE: LanguageModelV4Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** Sum two optionals, staying `undefined` only when both are `undefined`. */
const add = (
  a: number | undefined,
  b: number | undefined
): number | undefined =>
  a == null && b == null ? undefined : (a ?? 0) + (b ?? 0);

function sumUsage(list: LanguageModelV4Usage[]): LanguageModelV4Usage {
  return list.reduce<LanguageModelV4Usage>(
    (acc, u) => ({
      inputTokens: {
        total: add(acc.inputTokens.total, u.inputTokens.total),
        noCache: add(acc.inputTokens.noCache, u.inputTokens.noCache),
        cacheRead: add(acc.inputTokens.cacheRead, u.inputTokens.cacheRead),
        cacheWrite: add(acc.inputTokens.cacheWrite, u.inputTokens.cacheWrite),
      },
      outputTokens: {
        total: add(acc.outputTokens.total, u.outputTokens.total),
        text: add(acc.outputTokens.text, u.outputTokens.text),
        reasoning: add(acc.outputTokens.reasoning, u.outputTokens.reasoning),
      },
    }),
    EMPTY_USAGE
  );
}

/** Convert a usage record into JSON (undefined -> null) for `providerMetadata`. */
function usageToJson(u: LanguageModelV4Usage): JSONObject {
  const f = (n: number | undefined): number | null => (n == null ? null : n);
  return {
    inputTokens: {
      total: f(u.inputTokens.total),
      noCache: f(u.inputTokens.noCache),
      cacheRead: f(u.inputTokens.cacheRead),
      cacheWrite: f(u.inputTokens.cacheWrite),
    },
    outputTokens: {
      total: f(u.outputTokens.total),
      text: f(u.outputTokens.text),
      reasoning: f(u.outputTokens.reasoning),
    },
  } as unknown as JSONObject;
}

// ---------------------------------------------------------------------------
// Content / analysis helpers
// ---------------------------------------------------------------------------
function extractText(content: readonly LanguageModelV4Content[]): string {
  let out = "";
  for (const part of content) {
    if (part.type === "text") {
      out += part.text;
    }
  }
  return out;
}

function analysisToJsonObject(a: ParsedAnalysis): JSONObject {
  return stripInternal(a) as unknown as JSONObject;
}

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/gi;

/** Parse a string as a JSON object, or `null` (not an object / invalid). */
function tryParseObject(s: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(s);
    return o != null && typeof o === "object" && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** First fenced ```…``` block whose body parses as a JSON object. */
function fenceObject(raw: string): Record<string, unknown> | null {
  for (const m of raw.matchAll(FENCE_RE)) {
    const o = tryParseObject(m[1].trim());
    if (o) {
      return o;
    }
  }
  return null;
}

/**
 * First complete top-level `{…}` object via a string-aware brace scan (ignores
 * braces inside string literals, so trailing prose with a stray `}` is safe).
 */
function scanObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && --depth === 0) {
      return tryParseObject(raw.slice(start, i + 1));
    }
  }
  return null;
}

/**
 * Extract the first complete top-level JSON object from a judge response and
 * return its parsed value, or `null`. Tolerant of fenced ```json blocks,
 * surrounding prose, a stray `}` in trailing prose, and braces inside strings.
 */
function extractJson(raw: string): Record<string, unknown> | null {
  return fenceObject(raw) ?? scanObject(raw) ?? tryParseObject(raw.trim());
}

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Coerce an array of objects into a well-typed shape, dropping non-objects and
 * normalizing each field with its `coerce` map. Guarantees value types (not just
 * key presence) so downstream rendering/serialization can never hit a wrong type.
 */
function objArr<T extends object>(
  v: unknown,
  coerce: { [K in keyof T]: (value: unknown) => T[K] }
): T[] {
  if (!Array.isArray(v)) {
    return [];
  }
  const out: T[] = [];
  for (const x of v) {
    if (x == null || typeof x !== "object") {
      continue;
    }
    const rec = x as Record<string, unknown>;
    const item = {} as T;
    for (const key of Object.keys(coerce) as Array<keyof T>) {
      item[key] = coerce[key](rec[key as string]);
    }
    out.push(item);
  }
  return out;
}

/** Parse the judge's response into a well-typed analysis, or `null` if unusable. */
function parseAnalysis(raw: string): ParsedAnalysis | null {
  const o = extractJson(raw);
  if (!o) {
    return null;
  }
  return {
    consensus: strArr(o.consensus),
    contradictions: objArr<FusionAnalysis["contradictions"][number]>(
      o.contradictions,
      {
        point: str,
        positions: (v) =>
          objArr<{ label: string; claim: string }>(v, {
            label: str,
            claim: str,
          }),
      }
    ),
    partialCoverage: objArr<FusionAnalysis["partialCoverage"][number]>(
      o.partialCoverage,
      {
        aspect: str,
        coveredBy: strArr,
        missingFrom: strArr,
      }
    ),
    uniqueInsights: objArr<FusionAnalysis["uniqueInsights"][number]>(
      o.uniqueInsights,
      {
        label: str,
        insight: str,
      }
    ),
    blindSpots: strArr(o.blindSpots),
    ranking: objArr<FusionAnalysis["ranking"][number]>(o.ranking, {
      label: str,
      reason: str,
    }),
    synthesisGuidance: str(o.synthesisGuidance),
  };
}

/** True if a parsed analysis carries no usable signal (would lose the panel content). */
function isEmptyAnalysis(a: FusionAnalysis): boolean {
  return (
    a.consensus.length === 0 &&
    a.contradictions.length === 0 &&
    a.partialCoverage.length === 0 &&
    a.uniqueInsights.length === 0 &&
    a.blindSpots.length === 0 &&
    a.ranking.length === 0 &&
    a.synthesisGuidance.trim() === ""
  );
}

function degradedAnalysis(raw: string): ParsedAnalysis {
  return {
    consensus: [],
    contradictions: [],
    partialCoverage: [],
    uniqueInsights: [],
    blindSpots: [],
    ranking: [],
    synthesisGuidance: raw.trim(),
    _malformed: true,
  };
}

// ---------------------------------------------------------------------------
// Member normalization
// ---------------------------------------------------------------------------
interface NormalizedMember {
  fallbackEntries?: ProviderEntry[];
  kind: "bare" | "fallback";
  label: string;
  model: LanguageModelV4;
  supports?: Modality[];
  temperature?: number;
}

const isFallback = (m: unknown): m is { fallback: ProviderEntry[] } =>
  typeof m === "object" &&
  m !== null &&
  Array.isArray((m as { fallback?: unknown }).fallback);

const isMemberConfig = (item: FusionPanelItem): item is FusionMemberConfig =>
  typeof item === "object" &&
  item !== null &&
  "model" in item &&
  !isFallback(item) &&
  (item as { specificationVersion?: unknown }).specificationVersion ===
    undefined;

/** Spreadsheet-style label: A, B, …, Z, AA, AB, … */
function letterLabel(i: number): string {
  let n = i;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Model ${s}`;
}

/**
 * Declared `supports` of a router `ProviderEntry`, or `undefined` for a bare
 * `LanguageModelV4` / an entry that omits `supports` (a universal candidate).
 */
function entrySupports(e: ProviderEntry): Modality[] | undefined {
  return typeof e === "object" && e !== null && "supports" in e
    ? e.supports
    : undefined;
}

function asV4Model(m: unknown, ctx: string): LanguageModelV4 {
  if (
    typeof m !== "object" ||
    m === null ||
    (m as { specificationVersion?: unknown }).specificationVersion !== "v4"
  ) {
    throw new Error(
      `ai-router/fusion: ${ctx} must be a v4 LanguageModel object, not a model-id string or an older spec`
    );
  }
  return m as LanguageModelV4;
}

function resolveMember(
  m: FusionMember,
  label: string,
  ctx: string
): LanguageModelV4 {
  if (isFallback(m)) {
    if (!Array.isArray(m.fallback) || m.fallback.length === 0) {
      throw new Error(
        `ai-router/fusion: ${ctx} fallback list must be non-empty`
      );
    }
    return createRouter({ models: { [label]: m.fallback } })(
      label
    ) as LanguageModelV4;
  }
  return asV4Model(m, ctx);
}

function normalizePanel(panel: FusionPanelItem[]): NormalizedMember[] {
  const seen = new Set<string>();
  return panel.map((item, i) => {
    const autoLabel = letterLabel(i);
    let member: FusionMember;
    let label = autoLabel;
    let temperature: number | undefined;
    let supports: Modality[] | undefined;

    if (isMemberConfig(item)) {
      member = item.model;
      label = item.label ?? autoLabel;
      temperature = item.temperature;
      supports = item.supports;
    } else {
      member = item;
    }

    // Labels are the join key between the judge prompt and the analysis the
    // caller reads back — they must be unique or the judge conflates answers.
    if (seen.has(label)) {
      throw new Error(`ai-router/fusion: duplicate panel label "${label}"`);
    }
    seen.add(label);

    const kind = isFallback(member) ? "fallback" : "bare";
    const fallbackEntries = isFallback(member) ? member.fallback : undefined;
    const model = resolveMember(member, label, `panel member "${label}"`);
    return { model, label, temperature, supports, kind, fallbackEntries };
  });
}

// ---------------------------------------------------------------------------
// Concurrency-bounded settled pool
// ---------------------------------------------------------------------------
async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------
function generatorToStream<T>(
  gen: AsyncGenerator<T> | Generator<T>
): ReadableStream<T> {
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { done, value } = await gen.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

/**
 * Namespace a synth substream part's id so a forwarded text/reasoning block can
 * never collide with the wrapper's own `fusion-analysis` reasoning id. Only the
 * text and reasoning grouping ids are rewritten; semantic ids (source, tool-call,
 * response-metadata) are left untouched so they keep their meaning.
 */
const RE_ID_TYPES = new Set([
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
]);

function reIdSynthPart(
  part: LanguageModelV4StreamPart
): LanguageModelV4StreamPart {
  if (
    RE_ID_TYPES.has(part.type) &&
    typeof (part as { id?: unknown }).id === "string"
  ) {
    return {
      ...part,
      id: `synth:${(part as { id: string }).id}`,
    } as LanguageModelV4StreamPart;
  }
  return part;
}

const SYNTH_ERROR_REASON: LanguageModelV4FinishReason = {
  unified: "error",
  raw: "fusion-synth-error",
};

/**
 * What the output stream should do with one synth substream part:
 *  - `emit` a part downstream (re-id'd text/reasoning, raw, or an error part),
 *  - record `finish` state (reason + usage), and/or
 *  - `terminal` to stop the loop (a surfaced error).
 * An empty object means "skip" (the synth's own stream-start/finish/response-metadata).
 */
interface SynthAction {
  emit?: LanguageModelV4StreamPart;
  finish?: { reason: LanguageModelV4FinishReason; usage: LanguageModelV4Usage };
  terminal?: boolean;
}

function classifySynthPart(
  part: LanguageModelV4StreamPart,
  includeRawChunks: boolean
): SynthAction {
  switch (part.type) {
    case "stream-start":
    case "response-metadata":
      return {};
    case "finish":
      return { finish: { reason: part.finishReason, usage: part.usage } };
    case "error":
      return { emit: part, terminal: true };
    case "raw":
      return includeRawChunks ? { emit: part } : {};
    default:
      return { emit: reIdSynthPart(part) };
  }
}

// ---------------------------------------------------------------------------
// Internal pipeline result shapes
// ---------------------------------------------------------------------------
interface PanelAnswer {
  label: string;
  model: LanguageModelV4;
  result: LanguageModelV4GenerateResult;
  text: string;
  usage: LanguageModelV4Usage;
}

interface JudgeOutcome {
  analysis: ParsedAnalysis;
  /** Set when the structured analysis was unavailable. */
  degraded?: "judge-failed" | "judge-malformed";
  judgeUsage: LanguageModelV4Usage;
}

type DegradedReason =
  | "judge-failed"
  | "judge-malformed"
  | "single-survivor"
  | "single-survivor-passthrough";

// ---------------------------------------------------------------------------
// The fusion model
// ---------------------------------------------------------------------------
class FusionLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider: string;
  readonly modelId: string;

  private static counter = 0;
  private readonly fusionId = `fusion#${FusionLanguageModel.counter++}`;
  private readonly maxDepth = MAX_FUSION_DEPTH;

  private readonly panel: NormalizedMember[];
  private readonly judgeModel?: LanguageModelV4;
  private readonly synthModel?: LanguageModelV4;
  private readonly panelTemperature: number;
  private readonly judgeTemperature: number;
  private readonly synthTemperature?: number;
  private readonly reasoning?: ReasoningEffort;
  private readonly minPanelSuccess: number;
  private readonly concurrency: number;
  private readonly onInsufficientPanel: "error" | "passthrough";
  private readonly modalityBehavior: "filter" | "error";
  private readonly includeAnalysis: boolean | "metadata" | "reasoning";
  private readonly onEvent?: (event: FusionEvent) => void;
  private readonly onError?: OnFusionError;

  constructor(options: FusionOptions) {
    if (!Array.isArray(options.panel) || options.panel.length < 2) {
      throw new Error("ai-router/fusion: panel needs at least 2 members");
    }
    this.panel = normalizePanel(options.panel);
    this.judgeModel =
      options.judge === undefined
        ? undefined
        : resolveMember(options.judge, "judge", "judge");
    this.synthModel =
      options.synth === undefined
        ? undefined
        : resolveMember(options.synth, "synth", "synth");

    this.panelTemperature = options.panelTemperature ?? 0.7;
    this.judgeTemperature = options.judgeTemperature ?? 0;
    this.synthTemperature = options.synthTemperature;
    this.reasoning = options.reasoning;

    this.minPanelSuccess = options.minPanelSuccess ?? 1;
    if (this.minPanelSuccess < 1) {
      throw new Error("ai-router/fusion: minPanelSuccess must be >= 1");
    }
    this.concurrency = options.concurrency ?? Number.POSITIVE_INFINITY;
    this.onInsufficientPanel = options.onInsufficientPanel ?? "error";
    this.modalityBehavior = options.modalityBehavior ?? "filter";
    this.includeAnalysis = options.includeAnalysis ?? "metadata";
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    this.provider = options.providerId ?? "fusion";
    this.modelId = options.modelId ?? "fusion";

    // Direct self-reference guard: a fusion model can't be its own member.
    const direct = [
      ...this.panel.map((m) => m.model),
      ...(this.judgeModel ? [this.judgeModel] : []),
      ...(this.synthModel ? [this.synthModel] : []),
    ];
    for (const m of direct) {
      if (isFusionModel(m)) {
        throw new Error(
          "ai-router/fusion: a fusion model cannot be used directly as its own panel/judge/synth member"
        );
      }
    }

    FUSION_INSTANCES.add(this);
  }

  /**
   * Intersect `supportedUrls` across the whole panel: a media-type/pattern is
   * advertised as natively supported only if EVERY panel member supports it.
   * The same prompt fans out to all members, so anything not universally
   * supported must be downloaded by the SDK and handed to every member as data
   * (conservative — this can only cause more downloading, never a member
   * receiving a URL it can't fetch).
   */
  get supportedUrls(): LanguageModelV4["supportedUrls"] {
    return (async () => {
      const maps = await Promise.all(
        this.panel.map((m) => Promise.resolve(m.model.supportedUrls))
      );
      const [first, ...rest] = maps;
      if (!first) {
        return {};
      }
      const sig = (r: RegExp): string => `${r.source} ${r.flags}`;
      const result: Record<string, RegExp[]> = {};
      for (const key of Object.keys(first)) {
        if (!rest.every((m) => key in m)) {
          continue;
        }
        let common = first[key] ?? [];
        for (const m of rest) {
          const theirs = new Set((m[key] ?? []).map(sig));
          common = common.filter((r) => theirs.has(sig(r)));
        }
        if (common.length > 0) {
          result[key] = common;
        }
      }
      return result;
    })();
  }

  private get wantReasoning(): boolean {
    return (
      this.includeAnalysis === "reasoning" || this.includeAnalysis === true
    );
  }

  private get wantMetadata(): boolean {
    return this.includeAnalysis !== false;
  }

  private emit(event: FusionEvent): void {
    if (!this.onEvent) {
      return;
    }
    try {
      this.onEvent(event);
    } catch {
      // observer must never break the pipeline
    }
  }

  // -- recursion guard ------------------------------------------------------
  private guardEntry(
    options: LanguageModelV4CallOptions
  ): LanguageModelV4CallOptions {
    const g = options.providerOptions?.[GUARD_NS] as
      | { depth?: number; ancestry?: unknown }
      | undefined;
    const depth = typeof g?.depth === "number" ? g.depth : 0;
    const ancestry = Array.isArray(g?.ancestry)
      ? (g?.ancestry as string[])
      : [];

    if (depth + 1 > this.maxDepth) {
      throw new Error(
        `ai-router/fusion: max nesting depth ${this.maxDepth} exceeded`
      );
    }
    // Defense-in-depth cycle break. Unreachable while MAX_FUSION_DEPTH === 1
    // (depth and ancestry grow in lockstep, so the depth ceiling always trips
    // first); it becomes the real guard if the depth bound is ever raised.
    if (ancestry.includes(this.fusionId)) {
      throw new Error(
        "ai-router/fusion: recursive fusion detected (self in panel/judge/synth)"
      );
    }

    return {
      ...options,
      providerOptions: {
        ...options.providerOptions,
        [GUARD_NS]: {
          depth: depth + 1,
          ancestry: [...ancestry, this.fusionId],
        },
      },
    };
  }

  // -- modality filtering ---------------------------------------------------
  private filterByModality(options: LanguageModelV4CallOptions): {
    survivors: NormalizedMember[];
    dropped: { label: string; reason: string }[];
  } {
    const required = detectModalities(options.prompt);
    const survivors: NormalizedMember[] = [];
    const dropped: { label: string; reason: string }[] = [];

    for (const mem of this.panel) {
      let ok = true;
      if (mem.kind === "fallback") {
        // An entry with no declared `supports` is a universal candidate (matches
        // any modality); otherwise it must cover the required modalities.
        ok = (mem.fallbackEntries ?? []).some((e) => {
          const s = entrySupports(e);
          return s == null || supportsAll(s, required);
        });
      } else if (mem.supports) {
        // Bare member with no declared `supports` is opaque -> always kept.
        ok = supportsAll(mem.supports, required);
      }

      if (ok) {
        survivors.push(mem);
      } else {
        const reason = `cannot handle modalities: ${[...required].join(", ")}`;
        dropped.push({ label: mem.label, reason });
        if (this.modalityBehavior === "error") {
          throw new Error(
            `ai-router/fusion: panel member "${mem.label}" cannot handle the requested input modalities`
          );
        }
      }
    }

    if (survivors.length === 0) {
      throw new Error(
        "ai-router/fusion: no panel member can handle the requested input modalities"
      );
    }
    return { survivors, dropped };
  }

  // -- panel ----------------------------------------------------------------
  private async runPanel(
    survivors: NormalizedMember[],
    childOptions: LanguageModelV4CallOptions
  ): Promise<PanelAnswer[]> {
    const settled = await runPool(
      survivors,
      this.concurrency,
      async (mem, idx) => {
        this.emit({ type: "panel:start", label: mem.label });
        const panelOptions: LanguageModelV4CallOptions = {
          ...childOptions,
          temperature: mem.temperature ?? this.panelTemperature,
          reasoning: childOptions.reasoning ?? this.reasoning,
          tools: undefined,
          toolChoice: undefined,
        };
        try {
          const result = await mem.model.doGenerate(panelOptions);
          const text = extractText(result.content);
          this.emit({
            type: "panel:success",
            label: mem.label,
            text,
            usage: result.usage,
          });
          return {
            label: mem.label,
            text,
            usage: result.usage,
            model: mem.model,
            result,
          };
        } catch (error) {
          this.onError?.({
            stage: "panel",
            label: mem.label,
            index: idx,
            error,
          });
          this.emit({ type: "panel:error", label: mem.label, error });
          throw error;
        }
      }
    );

    const answers: PanelAnswer[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value.text.trim() !== "") {
        answers.push(s.value);
      }
    }
    return answers;
  }

  // -- judge ----------------------------------------------------------------
  private async runJudge(
    judgeModel: LanguageModelV4,
    original: string,
    answers: LabeledAnswer[],
    childOptions: LanguageModelV4CallOptions
  ): Promise<JudgeOutcome> {
    this.emit({ type: "judge:start" });
    try {
      const jr = await judgeModel.doGenerate({
        ...childOptions,
        prompt: buildJudgePrompt(original, answers),
        temperature: this.judgeTemperature,
        reasoning: childOptions.reasoning ?? this.reasoning,
        responseFormat: {
          type: "json",
          schema: ANALYSIS_JSON_SCHEMA,
          name: "fusion_analysis",
          description: "Structured comparison of candidate answers.",
        },
        tools: undefined,
        toolChoice: undefined,
      });

      const raw = extractText(jr.content);
      const parsed = parseAnalysis(raw);
      if (parsed && !isEmptyAnalysis(parsed)) {
        this.emit({ type: "judge:done", analysis: parsed, usage: jr.usage });
        return { analysis: parsed, judgeUsage: jr.usage };
      }
      this.emit({ type: "judge:malformed", raw });
      return {
        analysis: degradedAnalysis(raw),
        judgeUsage: jr.usage,
        degraded: "judge-malformed",
      };
    } catch (error) {
      this.onError?.({ stage: "judge", label: "judge", index: -1, error });
      this.emit({ type: "judge:error", error });
      return {
        analysis: degradedAnalysis(""),
        judgeUsage: EMPTY_USAGE,
        degraded: "judge-failed",
      };
    }
  }

  // -- synth ----------------------------------------------------------------
  private synthLadder(
    synthModel: LanguageModelV4,
    judgeModel: LanguageModelV4,
    answers: PanelAnswer[]
  ): Array<{ model: LanguageModelV4; source: FusionSynthSource }> {
    const ladder: Array<{ model: LanguageModelV4; source: FusionSynthSource }> =
      [{ model: synthModel, source: "synth" }];
    if (judgeModel !== synthModel) {
      ladder.push({ model: judgeModel, source: "judge-fallback" });
    }
    // Every surviving panel member is a viable last-resort writer, in panel order.
    for (const a of answers) {
      if (!ladder.some((s) => s.model === a.model)) {
        ladder.push({ model: a.model, source: "panel-fallback" });
      }
    }
    return ladder;
  }

  private synthCallOptions(
    childOptions: LanguageModelV4CallOptions,
    callerOptions: LanguageModelV4CallOptions,
    prompt: LanguageModelV4CallOptions["prompt"]
  ): LanguageModelV4CallOptions {
    return {
      ...childOptions,
      prompt,
      temperature: this.synthTemperature ?? callerOptions.temperature ?? 0.3,
      reasoning: childOptions.reasoning ?? this.reasoning,
      responseFormat: callerOptions.responseFormat,
      tools: undefined,
      toolChoice: undefined,
    };
  }

  // -- metadata -------------------------------------------------------------
  private buildMetadata(p: {
    analysis: ParsedAnalysis;
    requested: number;
    answers: PanelAnswer[];
    judgeUsage: LanguageModelV4Usage;
    synthUsage: LanguageModelV4Usage;
    degraded?: DegradedReason;
    synthSource: FusionSynthSource;
  }): SharedV4ProviderMetadata {
    const fusion: Record<string, unknown> = {
      analysis: p.analysis._malformed ? null : analysisToJsonObject(p.analysis),
      panel: {
        requested: p.requested,
        survived: p.answers.length,
        failed: p.requested - p.answers.length,
        labels: p.answers.map((a) => a.label),
      },
      stageUsage: {
        panel: usageToJson(sumUsage(p.answers.map((a) => a.usage))),
        judge: usageToJson(p.judgeUsage),
        synth: usageToJson(p.synthUsage),
      },
      degraded: p.degraded ?? null,
      synthSource: p.synthSource,
    };
    return { fusion: fusion as unknown as JSONObject };
  }

  private passthroughMetadata(
    answer: PanelAnswer,
    requested: number
  ): SharedV4ProviderMetadata {
    const fusion: Record<string, unknown> = {
      analysis: null,
      panel: {
        requested,
        survived: 1,
        failed: requested - 1,
        labels: [answer.label],
      },
      stageUsage: {
        panel: usageToJson(answer.usage),
        judge: null,
        synth: null,
      },
      degraded: "single-survivor-passthrough" satisfies DegradedReason,
      synthSource: "passthrough" satisfies FusionSynthSource,
    };
    return { fusion: fusion as unknown as JSONObject };
  }

  private buildWarnings(
    synthWarnings: SharedV4Warning[] | undefined,
    degraded: DegradedReason | undefined
  ): SharedV4Warning[] {
    const warnings: SharedV4Warning[] = synthWarnings ? [...synthWarnings] : [];
    if (degraded === "judge-failed") {
      warnings.push({
        type: "other",
        message:
          "fusion: judge stage failed; the final answer reconciled the raw panel answers without structured analysis.",
      });
    } else if (degraded === "judge-malformed") {
      warnings.push({
        type: "other",
        message:
          "fusion: judge returned unparseable analysis; the final answer reconciled the raw panel answers.",
      });
    }
    return warnings;
  }

  // -- doGenerate -----------------------------------------------------------
  async doGenerate(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4GenerateResult> {
    const childOptions = this.guardEntry(options);
    const { survivors, dropped } = this.filterByModality(options);
    this.emit({
      type: "panel:selected",
      labels: survivors.map((s) => s.label),
      dropped,
    });

    const answers = await this.runPanel(survivors, childOptions);
    const n = answers.length;

    if (n === 0) {
      throw new Error(
        "ai-router/fusion: all panel members failed or produced no answer"
      );
    }
    if (n < this.minPanelSuccess) {
      if (this.onInsufficientPanel === "passthrough" && n === 1) {
        return this.passthroughResult(answers[0], survivors.length);
      }
      throw new Error(
        `ai-router/fusion: only ${n}/${survivors.length} panel members produced an answer (min ${this.minPanelSuccess})`
      );
    }

    const judgeModel = this.judgeModel ?? answers[0].model;
    const synthModel = this.synthModel ?? judgeModel;
    const original = renderOriginal(options.prompt);

    const { analysis, judgeUsage, degraded } = await this.runJudge(
      judgeModel,
      original,
      answers,
      childOptions
    );
    const degradedFinal: DegradedReason | undefined =
      degraded ?? (n < 2 ? "single-survivor" : undefined);

    const synthPrompt = degraded
      ? buildDegradedSynthPrompt(original, answers, analysis.synthesisGuidance)
      : buildSynthPrompt(original, analysis);

    // Synth with fallback ladder.
    const ladder = this.synthLadder(synthModel, judgeModel, answers);
    this.emit({ type: "synth:start" });
    let synthResult: LanguageModelV4GenerateResult | undefined;
    let synthSource: FusionSynthSource = "synth";
    let lastError: unknown;
    for (const step of ladder) {
      try {
        synthResult = await step.model.doGenerate(
          this.synthCallOptions(childOptions, options, synthPrompt)
        );
        synthSource = step.source;
        break;
      } catch (error) {
        this.onError?.({
          stage: "synth",
          label: step.source,
          index: -1,
          error,
        });
        lastError = error;
      }
    }
    if (!synthResult) {
      throw (
        lastError ?? new Error("ai-router/fusion: synth produced no answer")
      );
    }
    this.emit({ type: "synth:done", usage: synthResult.usage });

    // Forward the synth's content verbatim (text, reasoning, and any source/file
    // parts), matching the streaming path so generate/stream stay symmetric. The
    // analysis reasoning block (if requested) is prepended.
    const content: LanguageModelV4Content[] = [];
    if (this.wantReasoning) {
      content.push({
        type: "reasoning",
        text: renderAnalysisMarkdown(analysis),
      });
    }
    content.push(...synthResult.content);

    return {
      content,
      finishReason: synthResult.finishReason,
      usage: sumUsage([
        ...answers.map((a) => a.usage),
        judgeUsage,
        synthResult.usage,
      ]),
      providerMetadata: this.wantMetadata
        ? this.buildMetadata({
            analysis,
            requested: survivors.length,
            answers,
            judgeUsage,
            synthUsage: synthResult.usage,
            degraded: degradedFinal,
            synthSource,
          })
        : undefined,
      warnings: this.buildWarnings(synthResult.warnings, degradedFinal),
    };
  }

  private passthroughResult(
    answer: PanelAnswer,
    requested: number
  ): LanguageModelV4GenerateResult {
    return {
      ...answer.result,
      providerMetadata: this.wantMetadata
        ? this.passthroughMetadata(answer, requested)
        : answer.result.providerMetadata,
    };
  }

  // -- doStream -------------------------------------------------------------
  async doStream(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4StreamResult> {
    const childOptions = this.guardEntry(options);
    const { survivors, dropped } = this.filterByModality(options);
    this.emit({
      type: "panel:selected",
      labels: survivors.map((s) => s.label),
      dropped,
    });

    const answers = await this.runPanel(survivors, childOptions);
    const n = answers.length;

    if (n === 0) {
      throw new Error(
        "ai-router/fusion: all panel members failed or produced no answer"
      );
    }
    if (n < this.minPanelSuccess) {
      if (this.onInsufficientPanel === "passthrough" && n === 1) {
        return {
          stream: this.singleAnswerStream(answers[0], survivors.length),
        };
      }
      throw new Error(
        `ai-router/fusion: only ${n}/${survivors.length} panel members produced an answer (min ${this.minPanelSuccess})`
      );
    }

    const judgeModel = this.judgeModel ?? answers[0].model;
    const synthModel = this.synthModel ?? judgeModel;
    const original = renderOriginal(options.prompt);

    const { analysis, judgeUsage, degraded } = await this.runJudge(
      judgeModel,
      original,
      answers,
      childOptions
    );
    const degradedFinal: DegradedReason | undefined =
      degraded ?? (n < 2 ? "single-survivor" : undefined);

    const synthPrompt = degraded
      ? buildDegradedSynthPrompt(original, answers, analysis.synthesisGuidance)
      : buildSynthPrompt(original, analysis);

    // Open the synth stream with a fallback ladder (before any part is emitted,
    // so a total synth failure rejects the promise and lets an outer router fall back).
    const ladder = this.synthLadder(synthModel, judgeModel, answers);
    this.emit({ type: "synth:start" });
    let synthStream: LanguageModelV4StreamResult | undefined;
    let synthSource: FusionSynthSource = "synth";
    let lastError: unknown;
    for (const step of ladder) {
      try {
        synthStream = await step.model.doStream(
          this.synthCallOptions(childOptions, options, synthPrompt)
        );
        synthSource = step.source;
        break;
      } catch (error) {
        this.onError?.({
          stage: "synth",
          label: step.source,
          index: -1,
          error,
        });
        lastError = error;
      }
    }
    if (!synthStream) {
      throw (
        lastError ?? new Error("ai-router/fusion: synth produced no stream")
      );
    }

    return {
      stream: this.buildOutputStream({
        synthStream,
        analysis,
        answers,
        judgeUsage,
        degraded: degradedFinal,
        synthSource,
        requested: survivors.length,
        includeRawChunks: options.includeRawChunks === true,
      }),
    };
  }

  private buildOutputStream(ctx: {
    synthStream: LanguageModelV4StreamResult;
    analysis: ParsedAnalysis;
    answers: PanelAnswer[];
    judgeUsage: LanguageModelV4Usage;
    degraded?: DegradedReason;
    synthSource: FusionSynthSource;
    requested: number;
    includeRawChunks: boolean;
  }): ReadableStream<LanguageModelV4StreamPart> {
    const self = this;

    type Peek =
      | {
          ok: true;
          warnings: SharedV4Warning[];
          pending?: IteratorResult<LanguageModelV4StreamPart>;
        }
      | { ok: false; error: unknown };

    async function* gen(): AsyncGenerator<LanguageModelV4StreamPart> {
      const it = ctx.synthStream.stream[Symbol.asyncIterator]();

      // Synth failed before producing anything — report it in-stream (past the gate).
      function* failNow(error: unknown): Generator<LanguageModelV4StreamPart> {
        yield {
          type: "stream-start",
          warnings: self.buildWarnings([], ctx.degraded),
        };
        yield { type: "error", error };
        yield self.finishPart(ctx, EMPTY_USAGE, SYNTH_ERROR_REASON);
      }

      function* reasoningBlock(): Generator<LanguageModelV4StreamPart> {
        yield { type: "reasoning-start", id: "fusion-analysis" };
        yield {
          type: "reasoning-delta",
          id: "fusion-analysis",
          delta: renderAnalysisMarkdown(ctx.analysis),
        };
        yield { type: "reasoning-end", id: "fusion-analysis" };
      }

      // Peek the first part for the synth's stream-start warnings.
      async function peek(): Promise<Peek> {
        try {
          const first = await it.next();
          if (!first.done && first.value.type === "stream-start") {
            return { ok: true, warnings: first.value.warnings ?? [] };
          }
          return { ok: true, warnings: [], pending: first };
        } catch (error) {
          return { ok: false, error };
        }
      }

      type StreamStep =
        | { type: "done" }
        | { type: "error"; error: unknown }
        | { type: "part"; value: LanguageModelV4StreamPart };

      const toStep = (
        r: IteratorResult<LanguageModelV4StreamPart>
      ): StreamStep =>
        r.done ? { type: "done" } : { type: "part", value: r.value };

      async function advance(): Promise<StreamStep> {
        try {
          return toStep(await it.next());
        } catch (error) {
          return { type: "error", error };
        }
      }

      // Pump the synth substream, yielding forwarded parts and RETURNING the
      // final state (so the post-loop finish lives in the caller, keeping each
      // function small).
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: irreducible per-part stream state machine (advance → classify → emit/finish/terminate); already decomposed into advance()/classifySynthPart()/toStep() helpers.
      async function* pump(
        start: IteratorResult<LanguageModelV4StreamPart> | undefined
      ): AsyncGenerator<
        LanguageModelV4StreamPart,
        {
          finishReason?: LanguageModelV4FinishReason;
          synthUsage: LanguageModelV4Usage;
          errored: boolean;
        }
      > {
        let first = start ? toStep(start) : undefined;
        let finishReason: LanguageModelV4FinishReason | undefined;
        let synthUsage = EMPTY_USAGE;
        let errored = false;
        for (;;) {
          const step = first ?? (await advance());
          first = undefined;
          if (step.type === "done") {
            break;
          }
          if (step.type === "error") {
            yield { type: "error", error: step.error };
            finishReason = SYNTH_ERROR_REASON;
            errored = true;
            break;
          }
          const action = classifySynthPart(step.value, ctx.includeRawChunks);
          if (action.emit) {
            yield action.emit;
          }
          if (action.finish) {
            finishReason = action.finish.reason;
            synthUsage = action.finish.usage;
          }
          if (action.terminal) {
            finishReason = SYNTH_ERROR_REASON;
            errored = true;
            break;
          }
        }
        return { finishReason, synthUsage, errored };
      }

      try {
        const head = await peek();
        if (!head.ok) {
          yield* failNow(head.error);
          return;
        }
        yield {
          type: "stream-start",
          warnings: self.buildWarnings(head.warnings, ctx.degraded),
        };
        if (self.wantReasoning) {
          yield* reasoningBlock();
        }
        const tail = yield* pump(head.pending);
        if (!tail.errored) {
          self.emit({ type: "synth:done", usage: tail.synthUsage });
        }
        yield self.finishPart(
          ctx,
          tail.synthUsage,
          tail.finishReason ?? { unified: "other", raw: undefined }
        );
      } finally {
        // Always release the synth substream — e.g. when the consumer cancels
        // the fused output stream mid-flight — so the provider connection isn't
        // orphaned.
        await it.return?.(undefined);
      }
    }

    return generatorToStream(gen());
  }

  private finishPart(
    ctx: {
      analysis: ParsedAnalysis;
      answers: PanelAnswer[];
      judgeUsage: LanguageModelV4Usage;
      degraded?: DegradedReason;
      synthSource: FusionSynthSource;
      requested: number;
    },
    synthUsage: LanguageModelV4Usage,
    finishReason: LanguageModelV4FinishReason
  ): LanguageModelV4StreamPart {
    return {
      type: "finish",
      finishReason,
      usage: sumUsage([
        ...ctx.answers.map((a) => a.usage),
        ctx.judgeUsage,
        synthUsage,
      ]),
      providerMetadata: this.wantMetadata
        ? this.buildMetadata({
            analysis: ctx.analysis,
            requested: ctx.requested,
            answers: ctx.answers,
            judgeUsage: ctx.judgeUsage,
            synthUsage,
            degraded: ctx.degraded,
            synthSource: ctx.synthSource,
          })
        : undefined,
    };
  }

  private singleAnswerStream(
    answer: PanelAnswer,
    requested: number
  ): ReadableStream<LanguageModelV4StreamPart> {
    const self = this;
    function* gen(): Generator<LanguageModelV4StreamPart> {
      yield { type: "stream-start", warnings: [] };
      const id = "passthrough";
      yield { type: "text-start", id };
      if (answer.text) {
        yield { type: "text-delta", id, delta: answer.text };
      }
      yield { type: "text-end", id };
      yield {
        type: "finish",
        finishReason: answer.result.finishReason,
        usage: answer.usage,
        providerMetadata: self.wantMetadata
          ? self.passthroughMetadata(answer, requested)
          : undefined,
      };
    }
    return generatorToStream(gen());
  }
}

/**
 * Create a deterministic always-fuse pipeline as a single {@link LanguageModelV4}.
 *
 * A panel of models answers the prompt in parallel, a judge compares the answers
 * into a structured analysis, and a synth model writes the final answer from that
 * analysis. Built entirely on `doGenerate`/`doStream` calls — provider-agnostic,
 * with no dependency on any hosted fusion service.
 *
 * The result drops straight into the AI SDK:
 *
 * @example
 * const fusion = createFusion({
 *   panel: [openrouter('anthropic/claude-opus-4'), openrouter('openai/gpt-5'), friendli('moonshotai/Kimi-K2.5')],
 * });
 * await generateText({ model: fusion, prompt: 'Compare ridge, lasso, and elastic-net regression.' });
 *
 * @example // composes with the router (per-slot fallback)
 * createFusion({
 *   panel: [
 *     { fallback: [{ provider: friendli, model: 'K2.5', supports: ['text'] }, { provider: openrouter, model: 'moonshotai/kimi-k2.5', supports: ['text'] }] },
 *     openrouter('openai/gpt-5'),
 *   ],
 * });
 */
export function createFusion(options: FusionOptions): LanguageModelV4 {
  return new FusionLanguageModel(options);
}
