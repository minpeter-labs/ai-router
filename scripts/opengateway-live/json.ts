import type { CallFailure, JsonRecord, ValueShape } from "./types";

const DEFAULT_OPENGATEWAY_BASE_URL = "https://apis.opengateway.ai/v1";
const CUSTOM_BASE_URL_FLAG = "OPENGATEWAY_ALLOW_CUSTOM_BASE_URL";

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function requiredOpenGatewayApiKey(): string {
  return requiredEnv("OPENGATEWAY_API_KEY");
}

export function requiredOpenGatewayBaseURL(): string {
  const value = process.env.AI_BASE_URL ?? DEFAULT_OPENGATEWAY_BASE_URL;
  if (process.env[CUSTOM_BASE_URL_FLAG] === "1") {
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AI_BASE_URL must be a valid URL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("AI_BASE_URL must not include credentials");
  }
  const isOpenGatewayHost =
    url.hostname === "opengateway.ai" ||
    url.hostname.endsWith(".opengateway.ai");
  if (url.protocol !== "https:" || !isOpenGatewayHost) {
    throw new Error(
      `AI_BASE_URL must be an HTTPS opengateway.ai URL unless ${CUSTOM_BASE_URL_FLAG}=1`
    );
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

export function redactedDiagnosticMessage(
  message: unknown,
  fallback = "upstream response body redacted"
): string {
  const text = typeof message === "string" ? message : String(message);
  if (text.length === 0) {
    return fallback;
  }
  const lower = text.toLowerCase();
  if (
    lower.includes("reasoning_details") ||
    lower.includes("reasoningdetails")
  ) {
    return "upstream diagnostic redacted because it referenced reasoning details";
  }
  return text
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replaceAll(/apik_[A-Za-z0-9._-]+/gi, "apik_[redacted]")
    .slice(0, 300);
}

export function errorResult(error: unknown, status?: number): CallFailure {
  const message = isRecord(error)
    ? (messageFromRecord(error) ?? "upstream response body redacted")
    : String(error);
  return {
    ok: false,
    status,
    errorType: error instanceof Error ? error.name : typeof error,
    message: redactedDiagnosticMessage(
      error instanceof Error ? error.message : message
    ),
  };
}
