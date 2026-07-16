import { snapshotJsonValue } from "./json-value";

export interface ProviderBodyJsonBudget {
  remaining: number;
  remainingCharacters: number;
}

/**
 * Copy JSON telemetry bodies when possible, but preserve values from the
 * provider-spec's intentionally opaque `unknown` body contract.
 */
export function snapshotProviderBody(
  value: unknown,
  budget?: ProviderBodyJsonBudget
): unknown {
  const snapshot = snapshotJsonValue(
    value,
    budget?.remaining,
    budget?.remainingCharacters
  );
  if (!snapshot.valid) {
    return value;
  }
  if (budget !== undefined) {
    budget.remaining -= snapshot.containers ?? 0;
    budget.remainingCharacters -= snapshot.characters ?? 0;
  }
  return snapshot.value;
}
