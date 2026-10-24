import { createPreviewSessionAtoms } from "@goat/client-runtime/state/preview-sessions";
import type { EnvironmentId, PreviewSession } from "@goat/contracts";

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
