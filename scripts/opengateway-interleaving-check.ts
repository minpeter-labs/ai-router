import { writeFile } from "node:fs/promises";
import { rawStreamProbe } from "./opengateway-interleaving/raw";
import { sdkStreamProbe } from "./opengateway-interleaving/sdk";
import type { ModelProbe, ProbeReport } from "./opengateway-interleaving/types";
import { requiredOpenGatewayApiKey } from "./opengateway-live/json";

const DEFAULT_MODELS = [
  "deepseek/deepseek-v4-flash",
  "minimax/MiniMax-M2.7",
  "minimax/MiniMax-M2.5",
] as const;

function csvModels(): readonly string[] {
  const configured = process.env.AI_INTERLEAVE_MODELS;
  if (configured === undefined || configured.length === 0) {
    return DEFAULT_MODELS;
  }
  return configured
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

async function main(): Promise<void> {
  const apiKey = requiredOpenGatewayApiKey();
  const baseURL = process.env.AI_BASE_URL ?? "https://apis.opengateway.ai/v1";
  const results: ModelProbe[] = [];
  for (const model of csvModels()) {
    results.push({
      model,
      raw: await rawStreamProbe(baseURL, apiKey, model),
      sdk: await sdkStreamProbe(baseURL, apiKey, model),
    });
  }
  const report: ProbeReport = {
    baseURL,
    generatedAt: new Date().toISOString(),
    results,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const out = process.env.AI_INTERLEAVE_OUT;
  if (out !== undefined && out.length > 0) {
    await writeFile(out, json);
    return;
  }
  process.stdout.write(json);
}

await main();
