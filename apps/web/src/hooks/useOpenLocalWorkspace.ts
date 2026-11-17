import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { DesktopAppActivationRequest } from "@goat/contracts";

import { handleDesktopAppActivationRequest } from "../desktopAppActivation";
import { isElectron } from "../env";
import { resolveLocalFolderTarget } from "../lib/localFolderTarget";
import { findProjectByPath, inferProjectTitleFromPath } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { readProjects, waitForProject } from "../state/entities";
import { usePrimaryEnvironment } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentShellHasSnapshot } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { reportProjectFailure } from "./useProjectGroupUpdate";
import { useNewThreadHandler } from "./useHandleNewThread";

/**
 * Opens a folder on this computer as a project: an existing project opens (and unarchives), a new
 * one is added. Used by `goat <dir>` activations and folders dropped on the sidebar. `target` says
 * where it would open; only a server on this computer can read the path, so `ready` stays false
 * until that server's projects have loaded and it is never another machine.
 */
export function useOpenLocalWorkspace() {
  const primaryEnvironment = usePrimaryEnvironment();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    label: "project unarchive",
  });
  const openThread = useNewThreadHandler();
  const shellHasSnapshot = useEnvironmentShellHasSnapshot(
    primaryEnvironment?.environmentId ?? null,
  );
  const target = resolveLocalFolderTarget({
    isDesktopRenderer: isElectron,
    localEnvironmentDisabled: isLocalEnvironmentDisabled(),
    primary: primaryEnvironment,
    shellHasSnapshot,
  });

  const open = (request: DesktopAppActivationRequest) =>
    handleDesktopAppActivationRequest(request, {
      getTarget: () =>
        target.kind === "ready"
          ? { environmentId: target.environmentId, platform: target.platform }
          : null,
      findProject: (environmentId, workspaceRoot) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === environmentId),
          workspaceRoot,
        ) ?? null,
      createProject: async (environmentId, workspaceRoot) => {
        const projectId = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          throw error instanceof Error ? error : new Error("GOAT could not add the project.");
        }
        return projectId;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      openThread: (projectRef) => {
        const project = readProjects().find(
          (candidate) =>
            candidate.environmentId === projectRef.environmentId &&
            candidate.id === projectRef.projectId,
        );
        // Opening an archived project's folder again brings the project back.
        if (project?.archivedAt != null) {
          void updateProject({
            environmentId: projectRef.environmentId,
            input: { projectId: projectRef.projectId, archived: false },
          }).then((result) => reportProjectFailure("Failed to unarchive project", result));
        }
        return openThread(projectRef);
      },
    });

  return { target, ready: target.kind === "ready", open };
}
