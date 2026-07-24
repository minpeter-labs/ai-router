import { detectModalities } from "../modality";
import type { Modality } from "../types";

// Helpers ---------------------------------------------------------------------

/** A model-level (V4) file part. `data` is irrelevant to detection — only
 *  `mediaType` is read — so a URL tag is used (no fetch happens in detection). */
export function filePart(mediaType: string) {
  return {
    type: "file" as const,
    mediaType,
    data: { type: "url" as const, url: new URL("https://x/y.bin") },
  };
}

/** detectModalities returns a Set; assert as a sorted array for determinism. */
export function sortedModalities(
  prompt: Parameters<typeof detectModalities>[0]
): Modality[] {
  return [...detectModalities(prompt)].sort();
}

export function sorted(mods: Modality[]): Modality[] {
  return [...mods].sort();
}
