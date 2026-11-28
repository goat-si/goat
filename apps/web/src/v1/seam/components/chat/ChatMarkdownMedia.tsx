// Seam (lane F): replaces v1 apps/web/src/components/chat/ChatMarkdownMedia.tsx @916b5cc. v1 loads markdown media through the asset server, media player and right panel. GOAT 2 serves no assets yet, so the
// image draws only a caller-supplied fallbackSrc. assetMediaActionsSource is v1's function minus the right-panel
// "open file" action (GOAT 2 has no right panel). Planned: GOAT 2 asset route.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import { memo, type ComponentProps, type CSSProperties } from "react";
import { mediaFileReference, mediaUrlReference } from "../../../packages/client-runtime/src/mediaReference.ts";
import type { AssetResource, EnvironmentId } from "@goat/contracts";
import type { MediaActionSource } from "../media/MediaActions.ts";
import type { ExpandedImagePreview } from "./ExpandedImagePreview.tsx";

type ChatMarkdownAssetResource = AssetResource;

export function assetMediaActionsSource(input: {
  readonly environmentId: EnvironmentId;
  readonly resource: ChatMarkdownAssetResource;
  readonly kind: "image" | "video";
  readonly name: string;
  readonly src: string | null;
  readonly workspaceRoot?: string | undefined;
  readonly originalUrl?: string | undefined;
  readonly downloadable?: boolean | undefined;
}): MediaActionSource {
  const { environmentId, resource } = input;
  const path =
    resource._tag === "media-file"
      ? resource.path
      : resource._tag === "workspace-file" && input.workspaceRoot
        ? `${input.workspaceRoot.replace(/[\\/]+$/, "")}/${resource.path}`
        : undefined;
  const reference = path
    ? mediaFileReference(path, input.workspaceRoot)
    : input.originalUrl
      ? mediaUrlReference(input.originalUrl)
      : undefined;
  return {
    kind: input.kind,
    name: input.name,
    src: input.src,
    ...(input.downloadable === false ? {} : { asset: { environmentId, resource } }),
    ...(reference ? { reference } : {}),
  };
}

export const ChatMarkdownAssetImage = memo(function ChatMarkdownAssetImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: ChatMarkdownAssetResource;
  readonly kind?: "image" | "video";
  readonly alt: string;
  readonly copyMarkdown?: string;
  readonly srcFragment?: string;
  readonly standalone?: boolean | undefined;
  readonly maxHeightRem?: number | undefined;
  readonly style?: CSSProperties | undefined;
  readonly className?: string | undefined;
  readonly imageProps?: Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style"> | undefined;
  readonly originalUrl?: string | undefined;
  readonly framed?: boolean | undefined;
  readonly fallbackSrc?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly workspaceMutationId?: string | null | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  if (!props.fallbackSrc) return null;
  return (
    <img
      {...props.imageProps}
      src={props.fallbackSrc}
      alt={props.alt}
      className={props.className}
      style={props.maxHeightRem ? { maxHeight: `${props.maxHeightRem}rem`, ...props.style } : props.style}
    />
  );
});
