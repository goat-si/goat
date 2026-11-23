import { use } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import type { ChatFileAttachment } from "../../types";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { buildAttachmentVideoAsset, buildAttachmentVideoPreview } from "./ExpandedImagePreview";
import { TimelineRowCtx } from "./timelineRowContext";

export function UserVideoAttachment({ file }: { readonly file: ChatFileAttachment }) {
  const ctx = use(TimelineRowCtx);
  // Row updates rebuild attachment objects, so the asset follows only the
  // fields it reads.
  const { downloadable, id, mimeType, name } = file;
  const environmentId = ctx.activeThreadEnvironmentId;
  const asset =
    downloadable === false
      ? null
      : buildAttachmentVideoAsset(environmentId, { id, mimeType, name });
  const resource = asset?.resource ?? null;
  const assetUrl = useAssetUrlState(ctx.activeThreadEnvironmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(ctx.activeThreadEnvironmentId, resource);
  const src = assetUrl._tag === "Success" ? assetUrl.url : (file.previewUrl ?? null);

  if (asset === null && src === null) {
    return (
      <div className="flex aspect-[4/3] w-full items-center justify-center rounded-lg border border-border/80 bg-black px-2 py-3 text-center text-2xs text-white/70">
        {file.name}
      </div>
    );
  }

  return (
    <MediaVideoPlayer
      src={src}
      sourceFailed={
        file.previewUrl === undefined && resource !== null && assetUrl._tag === "Failure"
      }
      label={file.name}
      preload="visible"
      onOpen={() => {
        const preview = buildAttachmentVideoPreview(ctx.activeThreadEnvironmentId, file);
        if (preview) ctx.onImageExpand(preview);
      }}
      className="block aspect-[4/3] w-full"
      videoClassName="aspect-auto size-full rounded-lg border border-border/80"
      stateClassName="aspect-auto min-h-full rounded-lg border border-border/80 bg-black text-white"
      onRetry={asset ? refreshAssetUrl : undefined}
      actionsSource={asset ? { kind: "video", name: file.name, src, asset } : undefined}
    />
  );
}
