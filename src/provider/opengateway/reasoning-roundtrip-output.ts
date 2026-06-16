import type {
  JSONValue,
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import {
  type OpenGatewayReasoningDetailsStore,
  REASONING_DETAILS_REF_KEY,
} from "./reasoning-roundtrip-store";

const OPENGATEWAY_KEY = "opengateway";

function assertNever(value: never): never {
  throw new TypeError(`Unsupported OpenGateway reasoning variant: ${value}`);
}

async function withOpenGatewayReasoningMetadata(
  metadata: SharedV4ProviderMetadata | undefined,
  details: readonly JSONValue[],
  reasoningDetailsStore: OpenGatewayReasoningDetailsStore
): Promise<SharedV4ProviderMetadata> {
  const ref = await reasoningDetailsStore.store(details);
  return {
    ...(metadata ?? {}),
    [OPENGATEWAY_KEY]: {
      ...(metadata?.[OPENGATEWAY_KEY] ?? {}),
      [REASONING_DETAILS_REF_KEY]: ref,
    },
  };
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
  if (details.length === 0) {
    return content;
  }

  const hasReasoning = content.some((part) => part.type === "reasoning");
  let attachedToText = false;
  const nextContent = await Promise.all(
    content.map((part) => {
      switch (part.type) {
        case "reasoning":
          return withDetailsOnContentPart(part, details, reasoningDetailsStore);
        case "text": {
          if (hasReasoning || attachedToText) {
            return part;
          }
          attachedToText = true;
          return withDetailsOnContentPart(part, details, reasoningDetailsStore);
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
          return assertNever(part);
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
            details,
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
  if (details.length === 0) {
    return part;
  }

  switch (part.type) {
    case "reasoning-delta":
    case "reasoning-end":
    case "reasoning-start":
    case "text-delta":
    case "text-end":
    case "text-start":
    case "tool-call":
      return {
        ...part,
        providerMetadata: await withOpenGatewayReasoningMetadata(
          part.providerMetadata,
          details,
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
      return part;
    default:
      return assertNever(part);
  }
}
