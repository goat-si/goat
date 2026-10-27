import type { EnvironmentId } from "@goat/contracts";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { useConnectionsReady, useWorkspaceEnvironments } from "../../state/workspace";
import { stampedEnvironmentProjectsLoading } from "./new-task-flow-state";

export function useNewTaskEnvironmentLoading(environmentId: EnvironmentId | null) {
  const connectionsReady = useConnectionsReady();
  const environment = useWorkspaceEnvironments().find(
    (candidate) => candidate.environmentId === environmentId,
  );
  const shell = useEnvironmentShellReadiness(environmentId);
  return stampedEnvironmentProjectsLoading({
    connectionsReady,
    connectionState: environment?.connectionState ?? null,
    shellCacheRead: shell.cacheRead,
    shellStatus: shell.status,
    shellHasError: shell.hasError,
  });
}
