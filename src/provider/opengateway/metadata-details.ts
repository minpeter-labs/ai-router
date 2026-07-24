import {
  isJSONObject,
  type JSONObject,
  type JSONValue,
} from "@ai-sdk/provider";
import { snapshotJsonValue } from "../../core/json-value";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "../../core/runtime-types";

const MAX_METADATA_BODY_CONTAINERS = 50_000;
const MAX_METADATA_BODY_CHARACTERS = 4_194_304;
const MAX_REASONING_CHOICES = 1024;
const MAX_REASONING_DETAILS = 1024;
const MAX_REASONING_DETAIL_CONTAINERS = 1000;
const MAX_REASONING_DETAIL_CHARACTERS = 65_536;
const MAX_REASONING_DETAILS_CONTAINERS = 10_000;
const MAX_REASONING_DETAILS_CHARACTERS = 1_048_576;
const reasoningDetailBudgets = new WeakMap<
  JSONValue[],
  { characters: number; containers: number; seen: Set<string> }
>();

export function canonicalJsonValueKey(value: JSONValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    const parts = new Array<string>(value.length);
    for (let index = 0; index < value.length; index += 1) {
      parts[index] = canonicalJsonValueKey(value[index] as JSONValue);
    }
    return `[${parts.join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = new Array<string>(keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    parts[index] =
      `${JSON.stringify(key)}:${canonicalJsonValueKey(value[key] as JSONValue)}`;
  }
  return `{${parts.join(",")}}`;
}

function reasoningDetailBudget(target: JSONValue[]): {
  characters: number;
  containers: number;
  seen: Set<string>;
} {
  const existing = reasoningDetailBudgets.get(target);
  if (existing !== undefined) {
    return existing;
  }
  const budget = { characters: 0, containers: 0, seen: new Set<string>() };
  const targetLength = target.length;
  const length =
    Number.isSafeInteger(targetLength) && targetLength >= 0
      ? Math.min(targetLength, MAX_REASONING_DETAILS)
      : 0;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(target, index)) {
      continue;
    }
    const snapshot = snapshotJsonValue(
      target[index],
      MAX_REASONING_DETAIL_CONTAINERS,
      MAX_REASONING_DETAIL_CHARACTERS
    );
    if (snapshot.valid && snapshot.value !== null) {
      budget.characters += snapshot.characters ?? 0;
      budget.containers += snapshot.containers ?? 0;
      budget.seen.add(canonicalJsonValueKey(snapshot.value as JSONValue));
    }
  }
  reasoningDetailBudgets.set(target, budget);
  return budget;
}

export function appendUniqueJsonDetails(
  target: JSONValue[],
  details: unknown
): void {
  const budget = reasoningDetailBudget(target);
  if (consumeGenuinePromise(details)) {
    return;
  }
  if (!Array.isArray(details)) {
    return;
  }
  let length = 0;
  try {
    const candidate = details.length;
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      return;
    }
    length = Math.min(candidate, MAX_REASONING_DETAILS);
  } catch {
    return;
  }
  consumeOwnDataPromiseFields(
    details,
    Array.from({ length }, (_, index) => index)
  );
  for (let index = 0; index < length; index += 1) {
    if (target.length >= MAX_REASONING_DETAILS) {
      return;
    }
    try {
      if (!Object.hasOwn(details, index)) {
        continue;
      }
      const snapshot = snapshotJsonValue(
        details[index],
        Math.min(
          MAX_REASONING_DETAIL_CONTAINERS,
          MAX_REASONING_DETAILS_CONTAINERS - budget.containers
        ),
        Math.min(
          MAX_REASONING_DETAIL_CHARACTERS,
          MAX_REASONING_DETAILS_CHARACTERS - budget.characters
        )
      );
      if (!snapshot.valid || snapshot.value === null) {
        continue;
      }
      const detail = snapshot.value as JSONValue;
      const key = canonicalJsonValueKey(detail);
      if (budget.seen.has(key)) {
        continue;
      }
      budget.seen.add(key);
      budget.characters += snapshot.characters ?? 0;
      budget.containers += snapshot.containers ?? 0;
      target.push(detail);
    } catch {
      // Ignore one hostile detail while preserving other bounded entries.
    }
  }
}

export function snapshotUniqueJsonDetails(details: unknown): JSONValue[] {
  const snapshot: JSONValue[] = [];
  appendUniqueJsonDetails(snapshot, details);
  return snapshot;
}

function appendReasoningDetailsValue(
  target: JSONValue[],
  value: unknown
): void {
  if (value === null || value === undefined) {
    return;
  }
  appendUniqueJsonDetails(target, Array.isArray(value) ? value : [value]);
}

export function snapshotMetadataBody(value: unknown): JSONObject | undefined {
  const snapshot = snapshotJsonValue(
    value,
    MAX_METADATA_BODY_CONTAINERS,
    MAX_METADATA_BODY_CHARACTERS
  );
  return snapshot.valid && isJSONObject(snapshot.value)
    ? snapshot.value
    : undefined;
}

export function collectChoiceReasoningDetails(body: unknown): JSONValue[] {
  const stableBody = snapshotMetadataBody(body);
  if (stableBody === undefined) {
    return [];
  }

  const choices = stableBody.choices;
  if (!Array.isArray(choices)) {
    return [];
  }

  const details: JSONValue[] = [];
  const choiceLength = choices.length;
  if (!Number.isSafeInteger(choiceLength) || choiceLength < 0) {
    return details;
  }
  const length = Math.min(choiceLength, MAX_REASONING_CHOICES);
  for (let index = 0; index < length; index += 1) {
    try {
      if (!Object.hasOwn(choices, index)) {
        continue;
      }
      const choice = choices[index];
      if (!isJSONObject(choice)) {
        continue;
      }
      const message = choice.message;
      if (isJSONObject(message)) {
        appendReasoningDetailsValue(details, message.reasoning_details);
      }
      const delta = choice.delta;
      if (isJSONObject(delta)) {
        appendReasoningDetailsValue(details, delta.reasoning_details);
      }
    } catch {
      // Ignore one hostile choice while retaining other bounded choices.
    }
  }
  return details;
}
