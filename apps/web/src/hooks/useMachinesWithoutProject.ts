import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import { AuthSourceControlWriteScope, resolveEnvironmentMachineKind } from "@goat/contracts";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import { defaultCloneDestination, projectRemoteUrl } from "../lib/addProjectToMachine";
import type { MachineCandidate } from "../lib/runOnArrival";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentsWithScope } from "../state/session";
import { canCloneProjectInto } from "./useAddProjectTargets";

/**
 * Connected machines without this project, for Run on. Each carries what picking it
 * would take: whether it can clone the project's remote, and into which folder.
 */
export function useMachinesWithoutProject(
  activeProject: EnvironmentProject | null,
  activeProjectIsScratch: boolean,
  projectEnvironments: readonly Pick<EnvironmentOption, "environmentId">[],
): readonly MachineCandidate[] {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canClone = useEnvironmentsWithScope(environments, AuthSourceControlWriteScope);
  if (!activeProject || activeProjectIsScratch) return [];
  const listed = new Set(projectEnvironments.map(({ environmentId }) => environmentId));
  const remoteUrl = projectRemoteUrl(activeProject);
  return environments
    .filter(({ environmentId }) => !listed.has(environmentId))
    .map((environment) => ({
      environmentId: environment.environmentId,
      projectId: null,
      label: environment.label,
      isPrimary: environment.environmentId === primaryEnvironmentId,
      machine: resolveEnvironmentMachineKind(environment.serverConfig ?? null),
      connected: environment.connection.phase === "connected",
      canClone: canCloneProjectInto(environment, canClone),
      remoteUrl,
      destinationPath: remoteUrl
        ? defaultCloneDestination(remoteUrl, environment.serverConfig?.settings)
        : "",
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}
