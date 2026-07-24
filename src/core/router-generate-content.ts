import {
  ASYNC_GENERATE_FIELD,
  type AsyncGenerateFieldError,
  captureGenerateFields,
  captureGenerateSiblings,
  captureGenerateSiblingValue,
  type GenerateJsonBudget,
  generateDiscriminant,
  generateField,
  snapshotGenerateFileData,
  snapshotProviderMetadata,
  snapshotRequiredJson,
  synchronousGenerateValue,
} from "./router-generate-snapshot";
import { MAX_GENERATE_CONTENT_PARTS } from "./router-generate-validation";
import { consumeOwnDataPromiseFields } from "./runtime-types";

export function snapshotContentPart(
  value: unknown,
  budget: GenerateJsonBudget
): unknown {
  synchronousGenerateValue(value);
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const type = generateDiscriminant(value, "type", [
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
    "url",
  ]);
  const keys = (() => {
    switch (type) {
      case "text":
      case "reasoning":
        return ["providerMetadata", "text"];
      case "custom":
        return ["kind", "providerMetadata"];
      case "file":
      case "reasoning-file":
        return ["data", "mediaType", "providerMetadata"];
      case "tool-approval-request":
        return ["approvalId", "providerMetadata", "toolCallId"];
      case "tool-call":
        return [
          "dynamic",
          "input",
          "providerExecuted",
          "providerMetadata",
          "toolCallId",
          "toolName",
        ];
      case "tool-result":
        return [
          "dynamic",
          "isError",
          "preliminary",
          "providerMetadata",
          "result",
          "toolCallId",
          "toolName",
        ];
      case "source":
        return ["providerMetadata", "sourceType"];
      default:
        return ["providerMetadata"];
    }
  })();
  const fields = captureGenerateFields(value, keys);
  let providerMetadata: unknown;
  let fileData: unknown;
  let toolResult: unknown;
  let sourceFields: Record<string, unknown> | undefined;
  const transformations: (() => void)[] = [
    () => {
      providerMetadata = snapshotProviderMetadata(
        fields.providerMetadata,
        budget
      );
    },
  ];
  if (type === "file" || type === "reasoning-file") {
    transformations.push(() => {
      fileData = snapshotGenerateFileData(fields.data, budget);
    });
  } else if (type === "tool-result") {
    transformations.push(() => {
      toolResult = snapshotRequiredJson(fields.result, budget);
    });
  } else if (type === "source") {
    transformations.push(() => {
      sourceFields =
        fields.sourceType === "url"
          ? captureGenerateFields(value, ["id", "title", "url"])
          : captureGenerateFields(value, [
              "filename",
              "id",
              "mediaType",
              "title",
            ]);
    });
  }
  captureGenerateSiblings(transformations);
  switch (type) {
    case "text":
    case "reasoning":
      return { providerMetadata, text: fields.text, type };
    case "custom":
      return { kind: fields.kind, providerMetadata, type };
    case "file":
    case "reasoning-file":
      return {
        data: fileData,
        mediaType: fields.mediaType,
        providerMetadata,
        type,
      };
    case "tool-approval-request":
      return {
        approvalId: fields.approvalId,
        providerMetadata,
        toolCallId: fields.toolCallId,
        type,
      };
    case "tool-call":
      return {
        dynamic: fields.dynamic,
        input: fields.input,
        providerExecuted: fields.providerExecuted,
        providerMetadata,
        toolCallId: fields.toolCallId,
        toolName: fields.toolName,
        type,
      };
    case "tool-result":
      return {
        dynamic: fields.dynamic,
        isError: fields.isError,
        preliminary: fields.preliminary,
        providerMetadata,
        result: toolResult,
        toolCallId: fields.toolCallId,
        toolName: fields.toolName,
        type,
      };
    case "source": {
      const sourceType = fields.sourceType;
      if (sourceFields === undefined) {
        throw new Error("source fields are unavailable");
      }
      if (sourceType === "url") {
        return {
          id: sourceFields.id,
          providerMetadata,
          sourceType,
          title: sourceFields.title,
          type,
          url: sourceFields.url,
        };
      }
      return {
        filename: sourceFields.filename,
        id: sourceFields.id,
        mediaType: sourceFields.mediaType,
        providerMetadata,
        sourceType,
        title: sourceFields.title,
        type,
      };
    }
    default:
      return { providerMetadata, type };
  }
}

export function snapshotGenerateContent(
  value: unknown,
  budget: GenerateJsonBudget
): unknown {
  synchronousGenerateValue(value);
  if (!Array.isArray(value)) {
    return value;
  }
  const length = generateField(value, "length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_GENERATE_CONTENT_PARTS
  ) {
    return new Array(MAX_GENERATE_CONTENT_PARTS + 1);
  }
  consumeOwnDataPromiseFields(
    value,
    Array.from({ length }, (_, index) => index)
  );
  const snapshot = new Array<unknown>(length);
  const failure: { error?: AsyncGenerateFieldError } = {};
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return new Array(length);
    }
    const part = captureGenerateSiblingValue(
      () => snapshotContentPart(generateField(value, index), budget),
      failure
    );
    if (part !== ASYNC_GENERATE_FIELD) {
      snapshot[index] = part;
    }
  }
  if (failure.error !== undefined) {
    throw failure.error;
  }
  return snapshot;
}
