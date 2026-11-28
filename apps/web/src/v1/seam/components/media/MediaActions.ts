// Seam (lane F): replaces v1 apps/web/src/components/media/MediaActions.tsx @916b5cc. Only the MediaActionSource type is needed (by the ExpandedImagePreview and ChatMarkdownMedia seams); copied verbatim.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import type { MediaReference } from "../../../packages/client-runtime/src/mediaReference.ts";
import type { AssetResource, EnvironmentId } from "@goat/contracts";

export interface MediaActionSource {
  readonly kind: "image" | "video";
  readonly name: string;
  readonly src: string | null;
  readonly reference?: MediaReference;
  readonly asset?: { readonly environmentId: EnvironmentId; readonly resource: AssetResource };
  readonly onOpenFile?: () => void;
}
