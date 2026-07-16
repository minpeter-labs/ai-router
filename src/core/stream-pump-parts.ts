import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { countJsonContainersUpTo } from "./json-value";
import { isBoundedIdentifier, isDenseArray } from "./runtime-types";
/**
 * A modality-filtered candidate, resolved to a concrete v4 model. `fullIndex` is
 * the candidate's position in the original (unfiltered) entries array — used to
 * drive cooldown stickiness.
 */
import {
  FRAMING_PARTS,
  MAX_PRELUDE_METADATA_NODES,
  MAX_PRELUDE_PARTS,
  MAX_PRELUDE_TEXT_CHARS,
  MAX_STREAM_WARNINGS,
  PROVIDER_METADATA_PARTS,
} from "./stream-part-fields";
import {
  type SnapshottedStreamPart,
  snapshotKnownStreamPart,
} from "./stream-part-snapshot";
import {
  consumeStreamMetadataStrings,
  validFinishPart,
  validKnownStreamPartShape,
  validWarning,
} from "./stream-part-validation";
import { FallbackPumpFailure } from "./stream-pump-failure";
import { InvalidModelStreamError } from "./stream-reader";

export abstract class FallbackPumpParts extends FallbackPumpFailure {
  protected isEmptyFinish(
    value: LanguageModelV4StreamPart,
    candidateHasOutput: boolean
  ): boolean {
    return this.partType(value) === "finish" && !candidateHasOutput;
  }

  protected preludeWouldOverflow(value: LanguageModelV4StreamPart): boolean {
    return (
      !this.candidateCommitted &&
      this.shouldBufferPart(value) &&
      (this.prelude.length >= MAX_PRELUDE_PARTS ||
        this.preludeMetadataNodes + this.bufferedMetadataNodes(value) >
          MAX_PRELUDE_METADATA_NODES ||
        this.preludeTextChars + this.bufferedTextLength(value) >
          MAX_PRELUDE_TEXT_CHARS)
    );
  }

  protected bufferedMetadataNodes(value: LanguageModelV4StreamPart): number {
    if (!PROVIDER_METADATA_PARTS.has(value.type)) {
      return 0;
    }
    const cached = this.metadataNodeCounts.get(value as object);
    if (cached !== undefined) {
      return cached;
    }
    const count = countJsonContainersUpTo(
      Reflect.get(value as object, "providerMetadata"),
      MAX_PRELUDE_METADATA_NODES + 1
    );
    this.metadataNodeCounts.set(value as object, count);
    return count;
  }

  protected bufferedTextLength(value: LanguageModelV4StreamPart): number {
    const type = this.partType(value);
    if (
      type === "text-delta" ||
      type === "reasoning-delta" ||
      type === "tool-input-delta"
    ) {
      return (Reflect.get(value as object, "delta") as string).length;
    }
    if (type === "raw") {
      const rawValue = Reflect.get(value as object, "rawValue");
      return typeof rawValue === "string" ? rawValue.length : 0;
    }
    return 0;
  }

  protected isOutputPart(value: LanguageModelV4StreamPart): boolean {
    return !this.shouldBufferPart(value) && this.partType(value) !== "finish";
  }

  protected shouldBufferPart(value: LanguageModelV4StreamPart): boolean {
    const type = this.partType(value);
    if (this.config.strictStreamValidation && type === "tool-input-delta") {
      // Strict mode waits for the final tool-call before exposing partial tool
      // input, so a malformed lifecycle can still fall back transparently.
      return true;
    }
    if (type === "text-delta" || type === "reasoning-delta") {
      return (
        (Reflect.get(value as object, "delta") as string).trim().length === 0
      );
    }
    return FRAMING_PARTS.has(type);
  }

  protected partType(value: LanguageModelV4StreamPart): string {
    return this.opaquePartTypes.get(value as object) ?? value.type;
  }

  protected validatePart(
    value: LanguageModelV4StreamPart
  ): unknown | undefined {
    try {
      if (!validKnownStreamPartShape(value)) {
        return new InvalidModelStreamError("stream part shape is malformed");
      }
      if (
        value.type === "stream-start" &&
        (!Array.isArray(value.warnings) ||
          value.warnings.length > MAX_STREAM_WARNINGS ||
          !isDenseArray(value.warnings) ||
          !value.warnings.every(validWarning))
      ) {
        return new InvalidModelStreamError("stream warnings are malformed");
      }
      if (!validFinishPart(value)) {
        return new InvalidModelStreamError("finish metadata is malformed");
      }
      if (this.config.strictStreamValidation) {
        this.validator.validate(value);
      }
      return;
    } catch (validationError) {
      return validationError instanceof InvalidModelStreamError
        ? validationError
        : new InvalidModelStreamError("stream metadata could not be read");
    }
  }

  protected async snapshotAndValidatePart(
    value: LanguageModelV4StreamPart,
    index: number
  ): Promise<LanguageModelV4StreamPart | undefined> {
    let snapshot: SnapshottedStreamPart;
    try {
      snapshot = snapshotKnownStreamPart(value, this.streamJsonBudget);
      if (snapshot.known) {
        consumeStreamMetadataStrings(snapshot.part, this.streamJsonBudget);
      } else if (isBoundedIdentifier(snapshot.type, 256)) {
        this.opaquePartTypes.set(
          snapshot.part as object,
          snapshot.type as string
        );
      } else {
        throw new Error("unknown stream part type is malformed");
      }
    } catch (error) {
      await this.onFailure(
        new InvalidModelStreamError(
          "stream part properties could not be read",
          error
        ),
        index
      );
      return;
    }
    const validationError = snapshot.known
      ? this.validatePart(snapshot.part)
      : undefined;
    if (validationError !== undefined) {
      await this.onFailure(validationError, index);
      return;
    }
    return snapshot.part;
  }
}
