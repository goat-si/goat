import {
  buildProjectCreateCommand,
  canCreateProjectInEnvironment,
  findExistingAddProject,
} from "@goat/client-runtime/operations/projects";
import type { EnvironmentConnectionPhase } from "@goat/client-runtime/connection";
import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import { inferProjectTitleFromPath } from "@goat/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type EnvironmentMachineKind,
  ProjectId,
} from "@goat/contracts";
import { useNavigation, type NavigationState, type ParamListBase } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { AsyncResult } from "effect/reactivity";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { useProjects, waitForProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentProxiedByHub, readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

export interface EnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly platform: string;
  readonly machine: EnvironmentMachineKind;
  readonly baseDirectory: string | null;
  readonly newProjectsRoot: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
  readonly supportsCloneTracking: boolean;
  readonly ghqCloneLayout: boolean;
}

export function getActiveRoute(navigation: {
  getState: () => NavigationState<ParamListBase> | undefined;
}) {
  const state = navigation.getState();
  return state?.routes[state.index];
}

export function useOpenNewTaskDraft() {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const selectDetail = useSelectWorkspaceDetail();
  return (
    params: {
      environmentId: EnvironmentId;
      projectId: ProjectId;
      title: string;
      cloning?: "1";
      draftId?: string;
    },
    originRoute: NavigationState<ParamListBase>["routes"][number] | undefined,
  ) => {
    const activeRoute = getActiveRoute(navigation);
    // A warm link can change the task without replacing its native route key.
    if (
      !originRoute ||
      activeRoute?.key !== originRoute.key ||
      activeRoute.name !== originRoute.name ||
      activeRoute.params !== originRoute.params
    )
      return;
    selectDetail({ name: "Thread", params: { draft: params } });
  };
}

export async function draftWithPrompt(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  prompt: string,
): Promise<string> {
  await waitForComposerDraftsLoaded();
  const draftId = createNewTaskDraft({ environmentId, projectId });
  setComposerDraftText(draftId, prompt);
  return draftId;
}

export function useOpenExistingProject(environment: EnvironmentOption | null) {
  const openNewTaskDraft = useOpenNewTaskDraft();
  const updateProject = useAtomCommand(projectEnvironment.update, {
    label: "project unarchive",
  });
  const projects = useProjects();

  return async (
    path: string,
    originRoute: ReturnType<typeof getActiveRoute>,
    clone?: { readonly remoteUrl: string; readonly prompt: string | null },
  ): Promise<boolean> => {
    if (!environment) return false;
    const existing = findExistingAddProject({
      projects,
      environmentId: environment.environmentId,
      path,
    });
    if (!existing) return false;
    // A folder holding another repository is not this clone; let the clone report it occupied.
    if (
      clone &&
      existing.repositoryIdentity?.canonicalKey !==
        sourceControlClients.repositoryKeyFromRemote(clone.remoteUrl)
    ) {
      return false;
    }
    const prompt = clone?.prompt;
    // Adding an archived project's folder again brings the project back.
    const unarchived =
      existing.archivedAt == null ||
      (
        await updateProject({
          environmentId: existing.environmentId,
          input: { projectId: existing.id, archived: false },
        })
      )._tag === "Success";
    Dialog.alert(
      "Project already exists",
      unarchived ? existing.title : `${existing.title} is still archived. Try again later.`,
    );
    openNewTaskDraft(
      {
        environmentId: existing.environmentId,
        projectId: existing.id,
        title: existing.title,
        ...(prompt
          ? await draftWithPrompt(existing.environmentId, existing.id, prompt).then(
              (draftId) => ({ draftId }),
              () => ({}),
            )
          : {}),
      },
      originRoute,
    );
    return true;
  };
}

export function useCreateProject(environment: EnvironmentOption | null) {
  const openNewTaskDraft = useOpenNewTaskDraft();
  const navigation = useNavigation();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openExistingProject = useOpenExistingProject(environment);

  return async (
    workspaceRoot: string,
    originRoute = getActiveRoute(navigation),
    lookupPath = workspaceRoot,
  ) => {
    if (
      !environment ||
      !canCreateProjectInEnvironment(environment.connectionState) ||
      !readEnvironmentScope(environment.environmentId, AuthOrchestrationOperateScope)
    ) {
      Dialog.alert(
        "Project not added",
        `This connection cannot add projects right now. Any existing files remain at ${workspaceRoot}.`,
      );
      return;
    }
    if (await openExistingProject(lookupPath, originRoute)) {
      return;
    }
    const projectId = ProjectId.make(uuidv4());
    const command = buildProjectCreateCommand({
      commandId: CommandId.make(uuidv4()),
      projectId,
      workspaceRoot,
      proxiedByHub: readEnvironmentProxiedByHub(environment.environmentId),
    });
    const result = await createProject({
      environmentId: environment.environmentId,
      input: command,
    });
    if (AsyncResult.isFailure(result)) {
      return result;
    }
    // A successful command can precede its project in the client store. The
    // draft treats a missing project as a reason to return to the chooser.
    const project = await waitForProject(
      { environmentId: environment.environmentId, projectId },
      15_000,
    );
    if (project === null) {
      Dialog.alert(
        "Project added",
        "The project was created but has not reached this device yet. It will appear in the project list once the connection catches up.",
      );
      return result;
    }
    openNewTaskDraft(
      {
        environmentId: environment.environmentId,
        projectId,
        title: inferProjectTitleFromPath(workspaceRoot),
      },
      originRoute,
    );
    return result;
  };
}
