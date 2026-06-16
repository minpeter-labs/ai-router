import type { JSONValue } from "@ai-sdk/provider";

export const REASONING_DETAILS_REF_KEY = "reasoningDetailsRef";

export interface OpenGatewayReasoningDetailsStore {
  load(
    ref: string
  ):
    | readonly JSONValue[]
    | undefined
    | Promise<readonly JSONValue[] | undefined>;
  store(details: readonly JSONValue[]): string | Promise<string>;
}

export interface OpenGatewayReasoningDetailsStoreSettings {
  maxEntries?: number;
  now?: () => number;
  refPrefix?: string;
  ttlMs?: number;
}

interface StoredReasoningDetails {
  readonly details: JSONValue[];
  readonly expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_REF_PREFIX = "opengateway-reasoning";
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function createRandomRef(prefix: string): string {
  if (globalThis.crypto?.randomUUID != null) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  if (globalThis.crypto?.getRandomValues != null) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return `${prefix}-${Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")}`;
  }

  throw new Error("OpenGateway reasoningDetailsRef requires Web Crypto");
}

export function createOpenGatewayReasoningDetailsStore({
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = Date.now,
  refPrefix = DEFAULT_REF_PREFIX,
  ttlMs = DEFAULT_TTL_MS,
}: OpenGatewayReasoningDetailsStoreSettings = {}): OpenGatewayReasoningDetailsStore {
  const reasoningDetailsByRef = new Map<string, StoredReasoningDetails>();

  function pruneExpired(currentTime: number): void {
    for (const [ref, stored] of reasoningDetailsByRef) {
      if (stored.expiresAt <= currentTime) {
        reasoningDetailsByRef.delete(ref);
      }
    }
  }

  function pruneOverflow(): void {
    while (reasoningDetailsByRef.size > maxEntries) {
      const oldestRef = reasoningDetailsByRef.keys().next().value;
      if (typeof oldestRef !== "string") {
        return;
      }
      reasoningDetailsByRef.delete(oldestRef);
    }
  }

  return {
    load(ref) {
      const currentTime = now();
      const stored = reasoningDetailsByRef.get(ref);
      if (stored == null) {
        return;
      }

      if (stored.expiresAt <= currentTime) {
        reasoningDetailsByRef.delete(ref);
        return;
      }

      return [...stored.details];
    },
    store(details) {
      const currentTime = now();
      pruneExpired(currentTime);

      const ref = createRandomRef(refPrefix);
      reasoningDetailsByRef.set(ref, {
        details: [...details],
        expiresAt: currentTime + ttlMs,
      });
      pruneOverflow();

      return ref;
    },
  };
}
