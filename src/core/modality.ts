import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { getTopLevelMediaType } from '@ai-sdk/provider-utils';

import type { Modality } from './types';

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
    if (message.role === 'system') {
      modalities.add('text');
      continue;
    }

    for (const part of message.content) {
      switch (part.type) {
        case 'text':
        case 'reasoning':
          modalities.add('text');
          break;

        case 'file': {
          // Strip any media-type parameters (e.g. `application/pdf; charset=…`)
          // before matching so `type/subtype` comparisons stay exact.
          const mediaType = part.mediaType.toLowerCase().split(';')[0].trim();

          // PDF is application/pdf — special-case before the top-level scan.
          if (mediaType === 'application/pdf' || mediaType === 'application/x-pdf') {
            modalities.add('pdf');
            break;
          }

          // Normalizes 'image/png', 'image/*' and bare 'image' all to 'image'.
          const top = getTopLevelMediaType(mediaType);
          if (top === 'image') modalities.add('image');
          else if (top === 'video') modalities.add('video');
          else if (top === 'audio') modalities.add('audio');
          else if (top === 'text') modalities.add('text');
          // Unknown top-level types (other application/*) are ignored.
          break;
        }

        // tool-call / tool-result / reasoning-file / custom / tool-approval-*:
        // not input modalities for routing — ignore.
        default:
          break;
      }
    }
  }

  return modalities;
}

/**
 * True iff every modality in `required` is present in the entry's `supports`.
 */
export function supportsAll(supports: Modality[], required: Set<Modality>): boolean {
  for (const modality of required) {
    if (!supports.includes(modality)) return false;
  }
  return true;
}
