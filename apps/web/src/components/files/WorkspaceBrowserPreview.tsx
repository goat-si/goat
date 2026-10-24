import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { Spinner } from "~/components/ui/spinner";

import { BrowserDocumentFrame, isPdfPreviewFile } from "./BrowserDocumentFrame";
import { refreshedRevision, workspacePreviewAssetResource } from "./filePreviewMode";

/**
 * HTML runs in a sandboxed frame with an opaque origin, so a page cannot reach
 * the app's session or storage.
 */
export function WorkspaceBrowserPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly workspaceMutationId: string | null;
  readonly refreshRequestId: number;
}) {
  const resource = workspacePreviewAssetResource({
    threadRef: props.threadRef,
    draft: props.draft,
    workspaceRoot: props.workspaceRoot,
    absolutePath: props.absolutePath,
  });
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const revision = refreshedRevision(props.workspaceMutationId, props.refreshRequestId);
  const revisionSuffix =
    revision === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(revision)}`;

  if (assetUrl._tag === "Failure") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load file preview.
      </div>
    );
  }
  if (assetUrl._tag !== "Success") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner size="lg" />
      </div>
    );
  }
  return (
    <BrowserDocumentFrame
      src={`${assetUrl.url}${revisionSuffix}`}
      documentKey={`${props.environmentId}:${resource._tag}:${props.threadRef.threadId}:${props.absolutePath}:${revision}`}
      title={props.title}
      pdf={isPdfPreviewFile(props.absolutePath)}
      onRetry={refreshAssetUrl}
      threadRef={props.threadRef}
    />
  );
}
