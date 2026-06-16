import type {
  JSONValue,
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";

const OPENGATEWAY_KEY = "opengateway";
const REASONING_DETAILS_KEY = "reasoningDetails";

function assertNever(value: never): never {
  throw new TypeError(`Unsupported OpenGateway reasoning variant: ${value}`);
}

function withOpenGatewayReasoningMetadata(
  metadata: SharedV4ProviderMetadata | undefined,
  details: readonly JSONValue[]
): SharedV4ProviderMetadata {
  return {
    ...(metadata ?? {}),
    [OPENGATEWAY_KEY]: {
      ...(metadata?.[OPENGATEWAY_KEY] ?? {}),
      [REASONING_DETAILS_KEY]: [...details],
    },
  };
}

function withDetailsOnContentPart(
  part: LanguageModelV4Content,
  details: readonly JSONValue[]
): LanguageModelV4Content {
  return {
    ...part,
    providerMetadata: withOpenGatewayReasoningMetadata(
      part.providerMetadata,
      details
    ),
  };
}

export function withReasoningDetailsOnContent(
  content: LanguageModelV4Content[],
  details: readonly JSONValue[]
): LanguageModelV4Content[] {
  if (details.length === 0) {
    return content;
  }

  const hasReasoning = content.some((part) => part.type === "reasoning");
  let attachedToText = false;
  const nextContent = content.map((part) => {
    switch (part.type) {
      case "reasoning":
        return withDetailsOnContentPart(part, details);
      case "text": {
        if (hasReasoning || attachedToText) {
          return part;
        }
        attachedToText = true;
        return withDetailsOnContentPart(part, details);
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
  });

  return hasReasoning || attachedToText
    ? nextContent
    : [
        ...nextContent,
        {
          type: "reasoning",
          text: "",
          providerMetadata: withOpenGatewayReasoningMetadata(
            undefined,
            details
          ),
        },
      ];
}

export function withReasoningPartMetadata(
  part: LanguageModelV4StreamPart,
  details: readonly JSONValue[]
): LanguageModelV4StreamPart {
  switch (part.type) {
    case "reasoning-delta":
    case "reasoning-end":
    case "reasoning-start":
      return {
        ...part,
        providerMetadata: withOpenGatewayReasoningMetadata(
          part.providerMetadata,
          details
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
    case "text-delta":
    case "text-end":
    case "text-start":
    case "tool-approval-request":
    case "tool-call":
    case "tool-input-delta":
    case "tool-input-end":
    case "tool-input-start":
    case "tool-result":
      return part;
    default:
      return assertNever(part);
  }
}
