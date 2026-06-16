const DEFAULT_MODELS = [
  "deepseek/deepseek-v4-flash",
  "minimax/MiniMax-M2.7",
  "minimax/MiniMax-M2.5",
] as const;

export function csvModels(): readonly string[] {
  const configured = process.env.AI_ROUNDTRIP_MODELS;
  if (configured === undefined || configured.length === 0) {
    return DEFAULT_MODELS;
  }
  return configured
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
