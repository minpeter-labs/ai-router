import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { isDateValue } from "./runtime-types";

/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */

import {
  type AsyncStreamFieldError,
  captureStreamSiblings,
  PROVIDER_METADATA_PARTS,
  STREAM_PART_FIELDS,
  snapshotRecordFields,
  snapshotStreamFinishReason,
  streamDiscriminant,
} from "./stream-part-fields";
import {
  type StreamJsonBudget,
  snapshotStreamFileData,
  snapshotStreamProviderMetadata,
  snapshotStreamRawValue,
  snapshotStreamRequiredJson,
  snapshotStreamUsage,
  snapshotStreamWarnings,
} from "./stream-part-json";
export interface SnapshottedStreamPart {
  known: boolean;
  part: LanguageModelV4StreamPart;
  type: unknown;
}

export function snapshotKnownStreamPart(
  value: LanguageModelV4StreamPart,
  budget: StreamJsonBudget
): SnapshottedStreamPart {
  const type = streamDiscriminant(value as object, "type", [
    "approvalId",
    "data",
    "delta",
    "dynamic",
    "error",
    "filename",
    "finishReason",
    "id",
    "input",
    "isError",
    "kind",
    "mediaType",
    "modelId",
    "preliminary",
    "providerExecuted",
    "providerMetadata",
    "rawValue",
    "result",
    "sourceType",
    "timestamp",
    "title",
    "toolCallId",
    "toolName",
    "url",
    "usage",
    "warnings",
  ]);
  if (typeof type !== "string") {
    return { known: false, part: value, type };
  }
  const fields = STREAM_PART_FIELDS[type];
  if (fields === undefined) {
    // Unknown future part types remain opaque pass-through values.
    return { known: false, part: value, type };
  }
  let sourceType: unknown;
  let selectedFields = fields;
  if (type === "source") {
    sourceType = streamDiscriminant(value as object, "sourceType", [
      "filename",
      "id",
      "mediaType",
      "providerMetadata",
      "title",
      "url",
    ]);
    if (sourceType === "url") {
      selectedFields = ["id", "url", "title", "providerMetadata"];
    } else if (sourceType === "document") {
      selectedFields = [
        "id",
        "mediaType",
        "filename",
        "title",
        "providerMetadata",
      ];
    } else {
      selectedFields = ["id", "title", "providerMetadata"];
    }
  }
  const directFailure: { error?: AsyncStreamFieldError } = {};
  const snapshot = snapshotRecordFields(
    value as object,
    type,
    selectedFields,
    directFailure
  );
  if (type === "source") {
    snapshot.sourceType = sourceType;
  }
  const tasks: (() => void)[] = [];
  const directError = directFailure.error;
  if (directError !== undefined) {
    tasks.push(() => {
      throw directError;
    });
  }
  if (PROVIDER_METADATA_PARTS.has(type)) {
    tasks.push(() => {
      snapshot.providerMetadata = snapshotStreamProviderMetadata(
        snapshot.providerMetadata,
        budget
      );
    });
  }
  if (type === "file" || type === "reasoning-file") {
    tasks.push(() => {
      snapshot.data = snapshotStreamFileData(snapshot.data, budget);
    });
  } else if (type === "finish") {
    tasks.push(
      () => {
        snapshot.finishReason = snapshotStreamFinishReason(
          snapshot.finishReason
        );
      },
      () => {
        snapshot.usage = snapshotStreamUsage(snapshot.usage, budget);
      }
    );
  } else if (type === "tool-result") {
    tasks.push(() => {
      snapshot.result = snapshotStreamRequiredJson(snapshot.result, budget);
    });
  } else if (type === "stream-start") {
    tasks.push(() => {
      snapshot.warnings = snapshotStreamWarnings(snapshot.warnings);
    });
  } else if (type === "raw") {
    tasks.push(() => {
      snapshot.rawValue = snapshotStreamRawValue(snapshot.rawValue, budget);
    });
  } else if (type === "response-metadata" && isDateValue(snapshot.timestamp)) {
    tasks.push(() => {
      snapshot.timestamp = new Date(
        Date.prototype.getTime.call(snapshot.timestamp)
      );
    });
  }
  captureStreamSiblings(tasks);
  return {
    known: true,
    part: snapshot as unknown as LanguageModelV4StreamPart,
    type,
  };
}
