// Seam (lane F): replaces v1 apps/web/src/components/chat/markdownImageGallery.ts @916b5cc. v1's module also imports media/connection runtime for markdown galleries. workGroupImageGallery is pure and copied verbatim.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview.tsx";

export function workGroupImageGallery(
  viewedImages: ReadonlyArray<{ readonly path: string; readonly item: ExpandedImageItem | null }>,
  clickedPath: string | null,
  preview: ExpandedImagePreview,
): ExpandedImagePreview {
  const selected = preview.images[preview.index];
  if (preview.images.length !== 1 || !selected) return preview;
  const images: ExpandedImageItem[] = [];
  let index = -1;
  for (const viewed of viewedImages) {
    if (viewed.path === clickedPath) {
      index = images.length;
      images.push(selected);
    } else if (viewed.item) {
      images.push(viewed.item);
    }
  }
  return index < 0 ? preview : { images, index };
}
