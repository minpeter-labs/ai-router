import type { JSONValue } from "@ai-sdk/provider";

export const REASONING_DETAILS_REF_KEY = "reasoningDetailsRef";

const reasoningDetailsByRef = new Map<string, JSONValue[]>();
let nextReasoningDetailsRef = 0;

export function storeReasoningDetails(details: readonly JSONValue[]): string {
  nextReasoningDetailsRef += 1;
  const ref = `opengateway-reasoning-${nextReasoningDetailsRef.toString(36)}`;
  reasoningDetailsByRef.set(ref, [...details]);
  return ref;
}

export function resolveReasoningDetailsRef(ref: string): readonly JSONValue[] {
  return reasoningDetailsByRef.get(ref) ?? [];
}
