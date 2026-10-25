import {
  createPreviewSessionAtoms,
  PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
  PREVIEW_SESSION_THUMBNAIL_WIDTH,
} from "@goat/client-runtime/state/preview-sessions";
import type { EnvironmentId, PreviewSessionFrameEvent } from "@goat/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const previewSessionsEnvironment = createPreviewSessionAtoms(connectionAtomRuntime);

export function usePreviewSessions(environmentId: EnvironmentId) {
  return useEnvironmentQuery(previewSessionsEnvironment.sessions({ environmentId, input: {} }));
}

/**
 * The latest picture of a desktop session, or why there is none; null before the first answer.
 * Pass a null session to stop watching, which stops the capture on the desktop.
 */
export function useDesktopSessionFrame(
  environmentId: EnvironmentId,
  sessionId: string | null,
): { readonly event: PreviewSessionFrameEvent | null; readonly failed: boolean } {
  const query = useEnvironmentQuery(
    sessionId === null
      ? null
      : previewSessionsEnvironment.frames({
          environmentId,
          input: {
            sessionId,
            maxWidth: PREVIEW_SESSION_THUMBNAIL_WIDTH,
            frameIntervalMs: PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
          },
        }),
  );
  return { event: query.data, failed: query.error !== null };
}
