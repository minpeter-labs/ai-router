import type { CallFailure, JsonRecord, ValueShape } from "./types";

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function requiredOpenGatewayApiKey(): string {
  const value = process.env.OPENGATEWAY_API_KEY ?? process.env.AI_API_KEY;
  if (value === undefined || value.length === 0) {
    throw new Error("OPENGATEWAY_API_KEY or AI_API_KEY is required");
  }
  return value;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordProp(
  record: JsonRecord,
  key: string
): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

export function arrayProp(record: JsonRecord, key: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

export function stringProp(
  record: JsonRecord | undefined,
  key: string
): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

export function shape(value: unknown): ValueShape {
  if (Array.isArray(value)) {
    const first = value[0];
    return isRecord(first)
      ? { kind: "array", length: value.length, keys: Object.keys(first).sort() }
      : { kind: "array", length: value.length };
  }
  if (isRecord(value)) {
    return { kind: "object", keys: Object.keys(value).sort() };
  }
  if (value === null) {
    return { kind: "null" };
  }
  return { kind: typeof value };
}

function messageFromRecord(error: JsonRecord): string | undefined {
  const nested = recordProp(error, "error");
  if (nested !== undefined) {
    return stringProp(nested, "message") || messageFromRecord(nested);
  }
  return stringProp(error, "message") || undefined;
}

export function errorResult(error: unknown, status?: number): CallFailure {
  const message = isRecord(error)
    ? (messageFromRecord(error) ?? JSON.stringify(error).slice(0, 300))
    : String(error);
  return {
    ok: false,
    status,
    errorType: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message.slice(0, 300) : message,
  };
}
