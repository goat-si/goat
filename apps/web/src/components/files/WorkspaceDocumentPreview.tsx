import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";
import { useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";

import { AttachmentFilePreview } from "./AttachmentFilePreview";
import { FileSurfaceLoading } from "./fileSurfaceChrome";

export function WorkspaceDocumentPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly document: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly name: string;
  readonly workspaceMutationId: string | null;
  readonly refreshRevision: number;
}) {
  const resource =
    props.draft && props.document
      ? {
          _tag: "draft-workspace-file" as const,
          cwd: props.workspaceRoot,
          path: props.absolutePath,
        }
      : {
          _tag: "media-file" as const,
          threadId: props.threadRef.threadId,
          path: props.absolutePath,
          ...(props.document ? {} : { disposition: "attachment" as const }),
        };
  // Drafts keep reloading on every workspace mutation, as before.
  const revisioned = resource._tag === "media-file";
  const assetUrl = useAssetUrlState(
    props.environmentId,
    revisioned ? resource : null,
    props.workspaceMutationId ?? undefined,
  );
  const resolved =
    assetUrl._tag === "Success" ? (assetUrl.fileRevision ?? props.workspaceMutationId) : undefined;
  // A reconnect reports Loading and keeps the last revision, so the open file stays loaded;
  // a failure (say the file was deleted) remounts so the preview shows its error.
  const [shown, setShown] = useState(resolved);
  if (resolved !== undefined && resolved !== shown) setShown(resolved);
  const revision = !revisioned
    ? props.workspaceMutationId
    : assetUrl._tag === "Failure"
      ? `failure:${props.workspaceMutationId}`
      : (resolved ?? shown);
  // Waiting on the first revision keeps the preview from mounting twice when it opens.
  if (revisioned && revision === undefined && assetUrl._tag === "Loading") {
    return <FileSurfaceLoading />;
  }
  return (
    <AttachmentFilePreview
      key={`${revision}:${props.refreshRevision}`}
      name={props.name}
      mimeType="application/octet-stream"
      sizeBytes={0}
      asset={{ environmentId: props.environmentId, resource }}
      origin="File"
    />
  );
}
