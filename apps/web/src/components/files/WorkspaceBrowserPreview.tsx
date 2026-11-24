import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";
import { useState } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { Spinner } from "~/components/ui/spinner";
import { DownloadIcon } from "~/components/solar";
import { toastManager } from "~/components/ui/toast";

import { BrowserDocumentFrame, isPdfPreviewFile } from "./BrowserDocumentFrame";
import { refreshedRevision, workspaceAssetResource } from "./filePreviewMode";
import { usePdfViewState } from "./pdf/usePdfViewState";
import { FILE_SURFACE_SUBHEADER_CLASS, FileSurfaceAction } from "./fileSurfaceChrome";

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
  const pdf = isPdfPreviewFile(props.absolutePath);
  const [saving, setSaving] = useState(false);
  const resource = workspaceAssetResource({
    kind: pdf ? "media-file" : "workspace-file",
    threadRef: props.threadRef,
    draft: props.draft,
    workspaceRoot: props.workspaceRoot,
    absolutePath: props.absolutePath,
  });
  const workspaceRevision = refreshedRevision(props.workspaceMutationId, props.refreshRequestId);
  const documentId = `${props.environmentId}:${resource._tag}:${props.threadRef.threadId}:${props.absolutePath}`;
  const pdfViewState = usePdfViewState(documentId);
  const assetUrl = useAssetUrlState(
    props.environmentId,
    resource,
    pdf ? workspaceRevision : undefined,
  );
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const fileRevision = pdf && assetUrl._tag === "Success" ? assetUrl.fileRevision : undefined;
  const revision = refreshedRevision(
    fileRevision ?? props.workspaceMutationId,
    props.refreshRequestId,
  );
  const revisionSuffix =
    revision === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}${fileRevision !== undefined ? "file" : "workspace"}-revision=${encodeURIComponent(revision)}`;

  if (assetUrl._tag === "Failure") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load file preview.
      </div>
    );
  }
  if (
    assetUrl._tag !== "Success" ||
    (pdf && assetUrl.fileRevision === undefined && assetUrl.waiting)
  ) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner size="lg" />
      </div>
    );
  }
  return (
    <>
      {pdf ? (
        <div className={FILE_SURFACE_SUBHEADER_CLASS} data-glass-layer>
          <span className="min-w-0 flex-1" />
          <FileSurfaceAction
            label={saving ? "Preparing file…" : "Save file"}
            disabled={saving}
            onPress={() => {
              setSaving(true);
              void (async () => {
                const url = await refreshAssetUrl();
                if (!url) throw new Error("Reconnect to the environment and try again.");
                const response = await fetch(url);
                if (!response.ok) throw new Error("The file could not be loaded. Try again.");
                const downloadUrl = URL.createObjectURL(await response.blob());
                setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
                const anchor = document.createElement("a");
                anchor.href = downloadUrl;
                anchor.download = props.title.split(/[\\/]/).at(-1) || props.title;
                anchor.click();
              })()
                .catch((cause: unknown) =>
                  toastManager.add({
                    type: "error",
                    title: "Could not save file",
                    description: cause instanceof Error ? cause.message : "Please try again.",
                  }),
                )
                .finally(() => setSaving(false));
            }}
          >
            <DownloadIcon className="size-3.5" />
          </FileSurfaceAction>
        </div>
      ) : null}
      <BrowserDocumentFrame
        src={`${assetUrl.url}${revisionSuffix}`}
        documentKey={`${props.environmentId}:${resource._tag}:${props.threadRef.threadId}:${props.absolutePath}:${revision}`}
        documentId={documentId}
        pdfViewState={pdfViewState}
        title={props.title}
        pdf={pdf}
        onRetry={refreshAssetUrl}
        threadRef={props.threadRef}
      />
    </>
  );
}
