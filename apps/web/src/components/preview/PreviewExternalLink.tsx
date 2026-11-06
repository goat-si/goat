import { previewStreamDownloadUrl } from "@goat/client-runtime/preview/server-browser-stream";
import type { ScopedThreadRef } from "@goat/contracts";
import { ensureLocalApi } from "~/localApi";
import { openEnvironmentUrlExternally } from "~/browser/openEnvironmentUrl";
import { usePreviewStreamAccess } from "~/state/previewStream";
import { toastManager } from "~/components/ui/toast";
import { PreviewFileNotShown } from "./PreviewUnreachable";

export function previewProfileName(
  profiles: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  profileId: string,
): string {
  return profiles.find((profile) => profile.id === profileId)?.name ?? "Removed profile";
}

const localApi = typeof window === "undefined" ? null : ensureLocalApi();

// A server tab's URL is the environment's address; a desktop tab's URL is what this device loaded.
export function openPreviewUrlExternally(
  environmentId: ScopedThreadRef["environmentId"],
  url: string,
  serverRendered: boolean,
) {
  const opened = serverRendered
    ? openEnvironmentUrlExternally(environmentId, url)
    : (localApi?.shell.openExternal(url) ?? Promise.resolve());
  void opened.catch((error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Unable to open in browser",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  });
}

export function ServerTabFileNotShown(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly url: string;
  readonly download: { readonly id: string; readonly fileName: string };
}) {
  const access = usePreviewStreamAccess(props.threadRef.environmentId);
  return (
    <PreviewFileNotShown
      url={props.url}
      fileName={props.download.fileName}
      downloadUrl={
        access
          ? previewStreamDownloadUrl(
              { access, threadId: props.threadRef.threadId, tabId: props.tabId },
              props.download.id,
            )
          : null
      }
      onOpen={() => openPreviewUrlExternally(props.threadRef.environmentId, props.url, true)}
    />
  );
}
