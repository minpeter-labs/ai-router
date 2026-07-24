import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { getTopLevelMediaType } from "@ai-sdk/provider-utils";

import type { Modality } from "./types";

type NonSystemMessage = Exclude<
  LanguageModelV4Prompt[number],
  { role: "system" }
>;
type PromptPart = NonSystemMessage["content"][number];

function addPartModalities(modalities: Set<Modality>, part: PromptPart): void {
  if (part.type === "text" || part.type === "reasoning") {
    modalities.add("text");
    return;
  }
  if (part.type === "file" || part.type === "reasoning-file") {
    modalities.add(fileModality(part.mediaType));
    return;
  }
  if (part.type !== "tool-result" || part.output.type !== "content") {
    return;
  }
  for (const output of part.output.value) {
    if (output.type === "file") {
      modalities.add(fileModality(output.mediaType));
    }
  }
}

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
      addPartModalities(modalities, part);
    }
  }

  return modalities;
}

/**
 * Map a single file part's media type to a routing modality. Unknown media
 * types remain files rather than disappearing from capability routing.
 */
function fileModality(rawMediaType: string): Modality {
  // Strip any media-type parameters (e.g. `application/pdf; charset=…`) before
  // matching so `type/subtype` comparisons stay exact.
  const mediaType = rawMediaType.toLowerCase().split(";")[0].trim();

  // PDF is application/pdf — special-case before the top-level scan.
  if (mediaType === "application/pdf" || mediaType === "application/x-pdf") {
    return "pdf";
  }

  // Normalizes 'image/png', 'image/*' and bare 'image' all to 'image'.
  const top = getTopLevelMediaType(mediaType);
  if (top === "image" || top === "video" || top === "audio") {
    return top;
  }

  // text/*, application/*, and vendor media types are still file parts and
  // require generic file support; they must not route to text-part-only models.
  return "file";
}

/**
 * True iff every modality in `required` is present in the entry's `supports`.
 *
 * An omitted (`undefined`) `supports` means the entry is a universal candidate
 * that matches ANY modality — it is never filtered out.
 */
export function supportsAll(
  supports: Modality[] | undefined,
  required: Set<Modality>
): boolean {
  if (supports === undefined) {
    return true;
  }
  for (const modality of required) {
    if (!supports.includes(modality)) {
      return false;
    }
  }
  return true;
}
