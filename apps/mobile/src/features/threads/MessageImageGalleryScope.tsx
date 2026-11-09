import type { EnvironmentId, ThreadId } from "@goat/contracts";
import type { ReactNode } from "react";

import { FilePreviewGallery } from "../../components/FilePreviewGallery";
import { composerImageGallery } from "../../lib/composerImageGallery";
import { mobileMediaConnection } from "../../lib/environmentMediaUri";
import { usePreparedConnection } from "../../state/session";
import { messageImageGallery } from "./messageImageGallery";
import type { ThreadFeedRow } from "./pending-thread-feed";

/** Pages through a message's images; it follows the connection itself, so feed rows need not. */
export function MessageImageGalleryScope(props: {
  entry: ThreadFeedRow;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  workspaceRoot: string | null | undefined;
  children: ReactNode;
}) {
  const { entry, environmentId, threadId, workspaceRoot } = props;
  const environmentConnection = mobileMediaConnection(usePreparedConnection(environmentId));
  const images =
    entry.type === "message"
      ? [
          ...messageImageGallery(entry.message, {
            environmentId,
            threadId,
            workspaceRoot,
            environmentConnection,
          }),
          ...composerImageGallery(entry.pendingMessage?.attachments ?? [], environmentId),
        ]
      : [];
  return <FilePreviewGallery value={images}>{props.children}</FilePreviewGallery>;
}
