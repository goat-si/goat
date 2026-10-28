import { resolveFilesystemReadAccess } from "@goat/client-runtime/state/filesystem";
import { isScratchProject } from "@goat/client-runtime/state/projects";
import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import {
  DEFAULT_SERVER_SETTINGS,
  GOAT_PROJECT_FILE_NAME,
  type ProjectReadFileResult,
} from "@goat/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@goat/shared/projectSettings";
import { parseGoatProjectFile } from "@goat/shared/goatProjectFile";
import { goatProjectFileReadPath } from "@goat/client-runtime/goat-project-file";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useProjectHasThreads } from "../../state/project-has-threads";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";

type WorkspaceMode = "local" | "worktree";

export function useNewTaskProjectDefaults(selectedProject: EnvironmentProject | null) {
  const selectedEnvironmentServerConfig = useEnvironmentServerConfig(
    selectedProject?.environmentId ?? null,
  );
  const isScratchDraft =
    selectedProject !== null &&
    isScratchProject(selectedProject, selectedEnvironmentServerConfig?.scratchWorkspaceRoot);
  const fileAccessSession = useEnvironmentQuery(
    selectedProject !== null && selectedProject.workspaceRoot !== ""
      ? environmentSession.sessionStateAtom(selectedProject.environmentId)
      : null,
  );
  const fileEnvironment = useEnvironmentPresentation(selectedProject?.environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const { canReadFiles } = fileAccess;
  const fileAccessPending =
    selectedProject !== null && selectedProject.workspaceRoot !== "" && fileAccess.isPending;
  const goatProjectFileQuery = useEnvironmentQuery(
    canReadFiles && selectedProject !== null && selectedProject.workspaceRoot !== ""
      ? projectEnvironment.readFile({
          environmentId: selectedProject.environmentId,
          input: {
            cwd: selectedProject.workspaceRoot,
            relativePath: GOAT_PROJECT_FILE_NAME,
            allowMissing: true,
          },
        })
      : null,
  );
  const projectFilePath = goatProjectFileReadPath(
    goatProjectFileQuery.data,
    goatProjectFileQuery.cause,
    goatProjectFileQuery.isPending,
  );
  const legacyProjectFileQuery = useEnvironmentQuery(
    canReadFiles &&
      selectedProject !== null &&
      selectedProject.workspaceRoot !== "" &&
      projectFilePath !== GOAT_PROJECT_FILE_NAME
      ? projectEnvironment.readFile({
          environmentId: selectedProject.environmentId,
          input: { cwd: selectedProject.workspaceRoot, relativePath: projectFilePath },
        })
      : null,
  );
  const goatProjectFileData = (
    projectFilePath === GOAT_PROJECT_FILE_NAME
      ? goatProjectFileQuery.data
      : legacyProjectFileQuery.data
  ) as ProjectReadFileResult | null;
  const goatProjectFile =
    goatProjectFileData === null ||
    goatProjectFileData.exists === false ||
    goatProjectFileData.truncated
      ? null
      : parseGoatProjectFile(goatProjectFileData.contents);
  const projectSettings = resolveProjectSettings(
    selectedEnvironmentServerConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    selectedProject?.id ?? null,
    selectedProject,
    goatProjectFile,
  );
  const canChooseWorkspace = !isScratchDraft;
  const selectedProjectHasThreads = useProjectHasThreads(selectedProject);
  const defaultWorkspaceMode: WorkspaceMode = canChooseWorkspace
    ? resolveNewThreadEnvMode({
        projectSettings,
        workspaceRoot: selectedProject?.workspaceRoot ?? null,
        newProjectsRoot: selectedEnvironmentServerConfig?.newProjectsRoot,
        projectHasThreads: selectedProjectHasThreads,
      })
    : "local";
  // Do not persist the provisional workspace default while goat.json is loading; it would override
  // the file's eventual default.
  const defaultWorkspaceModeSettled =
    projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    (!goatProjectFileQuery.isPending && !legacyProjectFileQuery.isPending && !fileAccessPending);
  return {
    serverConfig: selectedEnvironmentServerConfig,
    isScratch: isScratchDraft,
    projectSettings,
    defaultWorkspaceMode,
    defaultWorkspaceModeSettled,
  };
}
