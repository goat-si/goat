// Seam (lane F): replaces v1 apps/web/src/components/chat/ExpandedImagePreview.tsx @916b5cc. v1's file also resolves markdown media through the environment. Lifted code imports only the two types, copied verbatim.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import type { SnapShotSource } from "@goat/contracts";
import type { MediaActionSource } from "../media/MediaActions.ts";

export interface ExpandedImageItem {
  src: string | null;
  name: string;
  mimeType?: string;
  type?: "video";
  /** Revoke this owned object URL; other blob URLs belong to the timeline. */
  ownsSrc?: boolean;
  source?: SnapShotSource;
  onCopySnapshot?: () => Promise<void>;
  autoPlay?: boolean;
  originalUrl?: string;
  srcFragment?: string;
  actionsSource?: MediaActionSource;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}
