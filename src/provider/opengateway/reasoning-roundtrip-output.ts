import type {
  JSONValue,
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { isJSONObject } from "@ai-sdk/provider";
import { snapshotJsonValue } from "../../core/json-value";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "../../core/runtime-types";
import { snapshotUniqueJsonDetails } from "./metadata";
import {
  type OpenGatewayReasoningDetailsStore,
  REASONING_DETAILS_REF_KEY,
} from "./reasoning-roundtrip-store";

const OPENGATEWAY_KEY = "opengateway";
const MAX_REASONING_PARTS = 10_000;
const CONTENT_PART_KEYS = [
  "approvalId",
  "data",
  "dynamic",
  "filename",
  "id",
  "input",
  "isError",
  "kind",
  "mediaType",
  "preliminary",
  "providerExecuted",
  "providerMetadata",
  "result",
  "sourceType",
  "text",
  "title",
  "toolCallId",
  "toolName",
  "type",
  "url",
] as const;
const STREAM_PART_KEYS = [
  ...CONTENT_PART_KEYS,
  "delta",
  "error",
  "finishReason",
  "rawValue",
  "usage",
  "warnings",
] as const;

function partDiscriminant(
  value: unknown,
  keys: readonly string[],
  name: string
): { record: Record<string, unknown>; type: unknown } {
  if (consumeGenuinePromise(value)) {
    throw new TypeError(`${name} must be synchronous`);
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${name} must be an object`);
  }
  consumeOwnDataPromiseFields(value, keys);
  const type = Reflect.get(value, "type");
  if (consumeGenuinePromise(type)) {
    throw new TypeError(`${name} type must be synchronous`);
  }
  return { record: value as Record<string, unknown>, type };
}

function snapshotSelectedPart<T>(
  record: Record<string, unknown>,
  type: unknown,
  keys: readonly string[],
  name: string
): T {
  const snapshot: Record<string, unknown> = { type };
  let asyncField = false;
  for (const key of keys) {
    const field = Reflect.get(record, key);
    if (consumeGenuinePromise(field)) {
      asyncField = true;
    }
    snapshot[key] = field;
  }
  if (asyncField) {
    throw new TypeError(`${name} fields must be synchronous`);
  }
  return snapshot as T;
}

function snapshotContentParts(
  value: unknown
): Array<{ part: LanguageModelV4Content; type: unknown }> {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `reasoning content must contain at most ${MAX_REASONING_PARTS} parts`
    );
  }
  const length = Reflect.get(value, "length");
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_REASONING_PARTS
  ) {
    throw new TypeError(
      `reasoning content must contain at most ${MAX_REASONING_PARTS} parts`
    );
  }
  consumeOwnDataPromiseFields(
    value,
    Array.from({ length }, (_, index) => index)
  );
  const snapshot = new Array<{ part: LanguageModelV4Content; type: unknown }>(
    length
  );
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError("reasoning content must be a dense array");
    }
    const part = Reflect.get(value, index);
    const captured = partDiscriminant(
      part,
      CONTENT_PART_KEYS,
      "reasoning content part"
    );
    snapshot[index] = { part, type: captured.type } as {
      part: LanguageModelV4Content;
      type: unknown;
    };
  }
  return snapshot;
}

export function captureReasoningStreamPart(
  value: LanguageModelV4StreamPart
): LanguageModelV4StreamPart {
  const { record, type } = partDiscriminant(
    value,
    STREAM_PART_KEYS,
    "reasoning stream part"
  );
  if (type === "raw") {
    return snapshotSelectedPart(record, type, ["rawValue"], "raw stream part");
  }
  if (type === "tool-call") {
    return snapshotSelectedPart(
      record,
      type,
      [
        "dynamic",
        "input",
        "providerExecuted",
        "providerMetadata",
        "toolCallId",
        "toolName",
      ],
      "tool-call stream part"
    );
  }
  if (
    type === "reasoning-delta" ||
    type === "reasoning-end" ||
    type === "reasoning-start" ||
    type === "text-delta" ||
    type === "text-end" ||
    type === "text-start"
  ) {
    return snapshotSelectedPart(
      record,
      type,
      type.endsWith("delta")
        ? ["delta", "id", "providerMetadata"]
        : ["id", "providerMetadata"],
      "text or reasoning stream part"
    );
  }
  return value;
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported OpenGateway reasoning variant: ${value}`);
}

async function withOpenGatewayReasoningMetadata(
  metadata: SharedV4ProviderMetadata | undefined,
  details: readonly JSONValue[],
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): Promise<SharedV4ProviderMetadata | undefined> {
  let stableMetadata: SharedV4ProviderMetadata | undefined;
  try {
    const metadataSnapshot = snapshotJsonValue(metadata);
    stableMetadata =
      metadataSnapshot.valid && isJSONObject(metadataSnapshot.value)
        ? (metadataSnapshot.value as SharedV4ProviderMetadata)
        : undefined;
    const ref = await reasoningDetailsStore.store(details);
    if (typeof ref !== "string" || ref.length === 0 || ref.length > 256) {
      return stableMetadata;
    }
    return {
      ...stableMetadata,
      [OPENGATEWAY_KEY]: {
        ...(isJSONObject(stableMetadata?.[OPENGATEWAY_KEY])
          ? stableMetadata[OPENGATEWAY_KEY]
          : {}),
        [REASONING_DETAILS_REF_KEY]: ref,
      },
    };
  } catch {
    return stableMetadata;
  }
}

async function withDetailsOnContentPart(
  part: LanguageModelV4Content,
  details: readonly JSONValue[],
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): Promise<LanguageModelV4Content> {
  return {
    ...part,
    providerMetadata: await withOpenGatewayReasoningMetadata(
      part.providerMetadata,
      details,
      reasoningDetailsStore
    ),
  };
}

export async function withReasoningDetailsOnContent(
  content: LanguageModelV4Content[],
  details: readonly JSONValue[],
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): Promise<LanguageModelV4Content[]> {
  const stableDetails = snapshotUniqueJsonDetails(details);
  if (stableDetails.length === 0) {
    return content;
  }

  const capturedContent = snapshotContentParts(content);
  const hasReasoning = capturedContent.some(({ type }) => type === "reasoning");
  let attachedToText = false;
  const nextContent = await Promise.all(
    capturedContent.map(({ part, type }) => {
      switch (type) {
        case "reasoning":
          return withDetailsOnContentPart(
            snapshotSelectedPart(
              part,
              type,
              ["providerMetadata", "text"],
              "reasoning content part"
            ),
            stableDetails,
            reasoningDetailsStore
          );
        case "text": {
          if (hasReasoning || attachedToText) {
            return part;
          }
          attachedToText = true;
          return withDetailsOnContentPart(
            snapshotSelectedPart(
              part,
              type,
              ["providerMetadata", "text"],
              "text content part"
            ),
            stableDetails,
            reasoningDetailsStore
          );
        }
        case "custom":
        case "file":
        case "reasoning-file":
        case "source":
        case "tool-approval-request":
        case "tool-call":
        case "tool-result":
          return part;
        default:
          return assertNever(part as never);
      }
    })
  );

  return hasReasoning || attachedToText
    ? nextContent
    : [
        ...nextContent,
        {
          type: "reasoning",
          text: "",
          providerMetadata: await withOpenGatewayReasoningMetadata(
            undefined,
            stableDetails,
            reasoningDetailsStore
          ),
        },
      ];
}

export async function withReasoningPartMetadata(
  part: LanguageModelV4StreamPart,
  details: readonly JSONValue[],
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): Promise<LanguageModelV4StreamPart> {
  const capturedPart = captureReasoningStreamPart(part);
  const stableDetails = snapshotUniqueJsonDetails(details);
  if (stableDetails.length === 0) {
    return capturedPart;
  }

  switch (capturedPart.type) {
    case "reasoning-delta":
    case "reasoning-end":
    case "reasoning-start":
    case "text-delta":
    case "text-end":
    case "text-start":
    case "tool-call":
      return {
        ...capturedPart,
        providerMetadata: await withOpenGatewayReasoningMetadata(
          capturedPart.providerMetadata,
          stableDetails,
          reasoningDetailsStore
        ),
      };
    case "custom":
    case "error":
    case "file":
    case "finish":
    case "raw":
    case "reasoning-file":
    case "response-metadata":
    case "source":
    case "stream-start":
    case "tool-approval-request":
    case "tool-input-delta":
    case "tool-input-end":
    case "tool-input-start":
    case "tool-result":
      return capturedPart;
    default:
      return assertNever(capturedPart);
  }
}
