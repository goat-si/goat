import { createPreviewSessionAtoms } from "@goat/client-runtime/state/preview-sessions";
import type { EnvironmentId } from "@goat/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const previewSessionsEnvironment = createPreviewSessionAtoms(connectionAtomRuntime);

export function usePreviewSessions(environmentId: EnvironmentId) {
  return useEnvironmentQuery(previewSessionsEnvironment.sessions({ environmentId, input: {} }));
}
