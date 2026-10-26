import type { ComposerImageAttachment } from "~/composerDraftStore";

export function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Hydrated images get fresh lastModified values, so exclude it from dedupe.
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}
