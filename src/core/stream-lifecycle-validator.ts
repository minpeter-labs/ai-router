import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { isBoundedIdentifier } from "./runtime-types";
import { MAX_STRICT_TRACKED_IDS } from "./stream-part-fields";
import { InvalidModelStreamError } from "./stream-reader";

export class StreamLifecycleValidator {
  private finished = false;
  private readonly open = new Set<string>();
  private readonly pendingToolCalls = new Set<string>();
  private readonly seenToolCalls = new Set<string>();
  private responseMetadataSeen = false;
  private streamStarted = false;

  validate(part: LanguageModelV4StreamPart): void {
    if (this.finished) {
      throw new InvalidModelStreamError("part emitted after finish");
    }
    if (this.validateSpecialPart(part)) {
      return;
    }
    if (!this.streamStarted) {
      throw new InvalidModelStreamError(
        `${part.type} emitted before stream-start`
      );
    }
    const record = part as unknown as Record<string, unknown>;
    const id = isBoundedIdentifier(record.id) ? record.id : undefined;
    const family = part.type.split("-")[0];
    const key = id === undefined ? undefined : `${family}:${id}`;
    if (part.type.endsWith("-start") && key !== undefined) {
      if (this.open.has(key)) {
        throw new InvalidModelStreamError(`duplicate ${part.type}`);
      }
      this.assertTrackingCapacity(
        this.open,
        key,
        "too many open stream blocks"
      );
      this.open.add(key);
    } else if (part.type.endsWith("-delta") && key !== undefined) {
      if (!this.open.has(key)) {
        throw new InvalidModelStreamError(`${part.type} without start`);
      }
    } else if (
      part.type.endsWith("-end") &&
      key !== undefined &&
      !this.open.delete(key)
    ) {
      throw new InvalidModelStreamError(`${part.type} without start`);
    }
    if (part.type === "tool-input-end") {
      this.assertTrackingCapacity(
        this.pendingToolCalls,
        part.id,
        "too many pending tool calls"
      );
      this.pendingToolCalls.add(part.id);
    }
  }

  private assertTrackingCapacity(
    values: Set<string>,
    value: string,
    message: string
  ): void {
    if (!values.has(value) && values.size >= MAX_STRICT_TRACKED_IDS) {
      throw new InvalidModelStreamError(message);
    }
  }

  private validateSpecialPart(part: LanguageModelV4StreamPart): boolean {
    if (part.type === "finish") {
      if (!this.streamStarted) {
        throw new InvalidModelStreamError("finish emitted before stream-start");
      }
      if (this.open.size > 0) {
        throw new InvalidModelStreamError("finish emitted with open blocks");
      }
      if (this.pendingToolCalls.size > 0) {
        throw new InvalidModelStreamError(
          "finish emitted before completed tool inputs produced tool calls"
        );
      }
      this.finished = true;
      return true;
    }
    if (part.type === "stream-start") {
      if (this.streamStarted) {
        throw new InvalidModelStreamError("duplicate stream-start");
      }
      this.streamStarted = true;
      return true;
    }
    if (part.type === "tool-call") {
      if (!this.streamStarted) {
        throw new InvalidModelStreamError(
          "tool-call emitted before stream-start"
        );
      }
      if (this.seenToolCalls.has(part.toolCallId)) {
        throw new InvalidModelStreamError("duplicate tool-call id");
      }
      this.assertTrackingCapacity(
        this.seenToolCalls,
        part.toolCallId,
        "too many tool-call ids"
      );
      this.seenToolCalls.add(part.toolCallId);
      this.pendingToolCalls.delete(part.toolCallId);
      return true;
    }
    if (part.type === "response-metadata") {
      if (!this.streamStarted) {
        throw new InvalidModelStreamError(
          "response-metadata emitted before stream-start"
        );
      }
      if (this.responseMetadataSeen) {
        throw new InvalidModelStreamError("duplicate response-metadata");
      }
      this.responseMetadataSeen = true;
      return true;
    }
    return false;
  }
}
