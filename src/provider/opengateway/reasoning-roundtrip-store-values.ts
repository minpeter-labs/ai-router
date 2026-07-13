import type { JSONValue } from "@ai-sdk/provider";
import { consumeGenuinePromise } from "../../core/runtime-types";
import { appendUniqueJsonDetails } from "./metadata-details";

const MAX_REF_LENGTH = 256;

export function snapshotReasoningDetails(
  details: readonly JSONValue[]
): JSONValue[] {
  const snapshot: JSONValue[] = [];
  appendUniqueJsonDetails(snapshot, details);
  return snapshot;
}

export function snapshotStoreDetails(value: unknown): JSONValue[] {
  const asyncDetails = consumeGenuinePromise(value);
  if (asyncDetails || !Array.isArray(value)) {
    throw new TypeError(
      "reasoningDetailsStore details must be synchronous array"
    );
  }
  return snapshotReasoningDetails(value);
}

export function isValidReasoningDetailsRef(ref: unknown): ref is string {
  if (consumeGenuinePromise(ref)) {
    return false;
  }
  return (
    typeof ref === "string" && ref.length > 0 && ref.length <= MAX_REF_LENGTH
  );
}
