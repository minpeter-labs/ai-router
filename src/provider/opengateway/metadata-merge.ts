import {
  isJSONObject,
  isJSONValue,
  type JSONObject,
  type JSONValue,
  type SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { boundedEnumerableOwnKeys } from "../../core/http-headers";
import { snapshotJsonValue } from "../../core/json-value";

import { snapshotMetadataBody } from "./metadata-details";

const OPENGATEWAY_METADATA_KEY = "opengateway";
const MAX_METADATA_PROVIDERS = 128;
const MAX_METADATA_PROVIDER_NAME_LENGTH = 256;

export function extractRouting(body: unknown): JSONValue | undefined {
  const stableBody = snapshotMetadataBody(body);
  if (stableBody === undefined) {
    return;
  }

  const extra = stableBody.extra;
  if (isJSONObject(extra) && isJSONValue(extra.routing)) {
    return extra.routing;
  }

  return isJSONValue(stableBody.routing) ? stableBody.routing : undefined;
}

export function buildOpenGatewayMetadata(
  routing: JSONValue | undefined
): SharedV4ProviderMetadata | undefined {
  const metadata: JSONObject = {};
  if (routing !== undefined) {
    metadata.routing = routing;
  }
  return Object.keys(metadata).length > 0
    ? { [OPENGATEWAY_METADATA_KEY]: metadata }
    : undefined;
}

export function extractOpenGatewayMetadata(
  body: unknown
): SharedV4ProviderMetadata | undefined {
  return buildOpenGatewayMetadata(extractRouting(body));
}

export function mergeProviderMetadata(
  first?: SharedV4ProviderMetadata,
  second?: SharedV4ProviderMetadata
): SharedV4ProviderMetadata | undefined {
  const left = sanitizeProviderMetadata(first);
  const right = sanitizeProviderMetadata(second);
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }

  const merged: SharedV4ProviderMetadata = {};
  for (const providerName of boundedEnumerableOwnKeys(
    left,
    MAX_METADATA_PROVIDERS
  ) ?? []) {
    defineMetadata(merged, providerName, left[providerName]);
  }
  for (const providerName of boundedEnumerableOwnKeys(
    right,
    MAX_METADATA_PROVIDERS
  ) ?? []) {
    defineMetadata(
      merged,
      providerName,
      mergeMetadataObjects(
        Object.hasOwn(merged, providerName) ? merged[providerName] : undefined,
        right[providerName]
      )
    );
  }
  return sanitizeProviderMetadata(merged);
}

function defineMetadata(
  target: SharedV4ProviderMetadata,
  providerName: string,
  metadata: JSONObject
): void {
  Object.defineProperty(target, providerName, {
    configurable: true,
    enumerable: true,
    value: metadata,
    writable: true,
  });
}

function mergeMetadataObjects(
  first: JSONObject | undefined,
  second: JSONObject
): JSONObject {
  const merged: JSONObject = {};
  for (const source of [first, second]) {
    if (source === undefined) {
      continue;
    }
    for (const key of boundedEnumerableOwnKeys(source, 1024) ?? []) {
      Object.defineProperty(merged, key, {
        configurable: true,
        enumerable: true,
        value: source[key],
        writable: true,
      });
    }
  }
  return merged;
}

function sanitizeProviderMetadata(
  value: unknown
): SharedV4ProviderMetadata | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const keys = boundedEnumerableOwnKeys(value, MAX_METADATA_PROVIDERS);
  if (
    keys === undefined ||
    keys.some(
      (key) =>
        key.length === 0 || key.length > MAX_METADATA_PROVIDER_NAME_LENGTH
    )
  ) {
    return;
  }
  const snapshot = snapshotJsonValue(value);
  if (
    !snapshot.valid ||
    typeof snapshot.value !== "object" ||
    snapshot.value === null ||
    Array.isArray(snapshot.value)
  ) {
    return;
  }
  const metadata = snapshot.value as Record<string, unknown>;
  for (const key of keys) {
    const item = metadata[key];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return;
    }
  }
  return metadata as SharedV4ProviderMetadata;
}
