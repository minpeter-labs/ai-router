import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { getTopLevelMediaType } from "@ai-sdk/provider-utils";

import type { Modality } from "./types";

/**
 * Scan a model-level prompt (`LanguageModelV4Prompt`, spec v4 — what the AI SDK
 * passes into `doGenerate`/`doStream`) and report which input modalities appear.
 *
 * V4 details that matter here:
 *  - File input is a content part with `type: 'file'` (`LanguageModelV4FilePart`).
 *  - The IANA media type lives in `part.mediaType` (NOT `mimeType`).
 *  - `mediaType` may be a full `type/subtype` (e.g. `image/png`), a bare
 *    top-level segment (e.g. `image`), or an `image/*` wildcard. We normalize
 *    via `getTopLevelMediaType()` so all three forms work.
 *  - PDF is `application/pdf` (top-level `application`), so it is special-cased
 *    rather than matched by top-level prefix.
 *  - `part.data` is a tagged union (`SharedV4FileData`); irrelevant for
 *    modality routing — we only read `mediaType`.
 *  - Only `user`/`assistant` messages carry input parts; `system` content is a
 *    plain string (pure text).
 */
export function detectModalities(prompt: LanguageModelV4Prompt): Set<Modality> {
  const modalities = new Set<Modality>();

  for (const message of prompt) {
    if (message.role === "system") {
      modalities.add("text");
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text" || part.type === "reasoning") {
        modalities.add("text");
      } else if (part.type === "file") {
        const modality = fileModality(part.mediaType);
        if (modality !== null) {
          modalities.add(modality);
        }
      }
      // Other part types (tool-call / tool-result / reasoning-file / custom /
      // tool-approval-*) are not input modalities for routing — ignored.
    }
  }

  return modalities;
}

/**
 * Map a single file part's media type to a routing modality, or `null` when it
 * is not one we route on. Extracted from {@link detectModalities} to keep that
 * scan's nesting (and cognitive complexity) low.
 */
function fileModality(rawMediaType: string): Modality | null {
  // Strip any media-type parameters (e.g. `application/pdf; charset=…`) before
  // matching so `type/subtype` comparisons stay exact.
  const mediaType = rawMediaType.toLowerCase().split(";")[0].trim();

  // PDF is application/pdf — special-case before the top-level scan.
  if (mediaType === "application/pdf" || mediaType === "application/x-pdf") {
    return "pdf";
  }

  // Normalizes 'image/png', 'image/*' and bare 'image' all to 'image'.
  const top = getTopLevelMediaType(mediaType);
  if (top === "image" || top === "video" || top === "audio" || top === "text") {
    return top;
  }

  // Unknown top-level types (other application/*) are not routed on.
  return null;
}

/**
 * True iff every modality in `required` is present in the entry's `supports`.
 */
export function supportsAll(
  supports: Modality[],
  required: Set<Modality>
): boolean {
  for (const modality of required) {
    if (!supports.includes(modality)) {
      return false;
    }
  }
  return true;
}
