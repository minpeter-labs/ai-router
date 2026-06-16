import { writeFile } from "node:fs/promises";
import { requiredOpenGatewayApiKey } from "./opengateway-live/json";
import {
  listModels,
  rawBody,
  rawCall,
  rawToolBody,
} from "./opengateway-live/raw";
import { sdkGenerate, sdkStream, sdkTool } from "./opengateway-live/sdk";
import type { LiveCheckResult, ModelResult } from "./opengateway-live/types";

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function chooseCandidates(catalogIds: readonly string[]): readonly string[] {
  const fromEnv = [process.env.AI_MODEL, process.env.AI_EXTRA_MODELS]
    .filter(isNonEmptyString)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const max = Number.parseInt(process.env.AI_LIVE_MAX_MODELS ?? "8", 10);
  return [...new Set([...fromEnv, ...catalogIds])].slice(0, max);
}

async function runModel(
  baseURL: string,
  apiKey: string,
  model: string
): Promise<ModelResult> {
  return {
    model,
    raw: {
      none: await rawCall(baseURL, apiKey, rawBody(model, "none")),
      high: await rawCall(baseURL, apiKey, rawBody(model, "high")),
      tool: await rawCall(baseURL, apiKey, rawToolBody(model)),
    },
    sdk: {
      none: await sdkGenerate(baseURL, apiKey, model, "none"),
      high: await sdkGenerate(baseURL, apiKey, model, "high"),
      streamHigh: await sdkStream(baseURL, apiKey, model),
      tool: await sdkTool(baseURL, apiKey, model),
    },
  };
}

async function main(): Promise<void> {
  const apiKey = requiredOpenGatewayApiKey();
  const baseURL = process.env.AI_BASE_URL ?? "https://apis.opengateway.ai/v1";
  const catalog = await listModels(baseURL, apiKey);
  const candidates = chooseCandidates(catalog.ids);
  const results: ModelResult[] = [];
  for (const candidate of candidates) {
    results.push(await runModel(baseURL, apiKey, candidate));
  }
  const report: LiveCheckResult = {
    generatedAt: new Date().toISOString(),
    baseURL,
    modelCatalog: catalog,
    candidates,
    results,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const out = process.env.AI_LIVE_OUT;
  if (out !== undefined && out.length > 0) {
    await writeFile(out, json);
    return;
  }
  process.stdout.write(json);
}

await main();
