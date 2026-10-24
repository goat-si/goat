import {
  createPreviewSessionAtoms,
  PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
  PREVIEW_SESSION_THUMBNAIL_WIDTH,
} from "@goat/client-runtime/state/preview-sessions";
import type { EnvironmentId, PreviewSession, PreviewSessionFrameEvent } from "@goat/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const previewSessionsEnvironment = createPreviewSessionAtoms(connectionAtomRuntime);

const NO_SESSIONS: ReadonlyArray<PreviewSession> = [];

/** Every agent-driven browser tab and desktop session on the environment's host. */
export function usePreviewSessions(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : previewSessionsEnvironment.sessions({ environmentId, input: {} }),
  );
  return query.data?.sessions ?? NO_SESSIONS;
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
