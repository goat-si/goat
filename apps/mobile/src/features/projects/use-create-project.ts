import {
  type SourceControlOfferSettings,
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
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects, waitForProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentProxiedByHub, readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  composerDraftsAtom,
  createNewTaskDraft,
  retargetNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { readNewTaskFlowState } from "../threads/new-task-flow-state";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { chooserDraftKey } from "./AddProjectScreen.logic";

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
  readonly sourceControlOfferSettings: SourceControlOfferSettings | undefined;
}

export function getActiveRoute(navigation: {
  getState: () => NavigationState<ParamListBase> | undefined;
}) {
  const state = navigation.getState();
  return state?.routes[state.index];
}

async function retargetSavedNewTaskDraft(
  draftKey: string,
  project: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): Promise<boolean> {
  await waitForComposerDraftsLoaded();
  if (appAtomRegistry.get(composerDraftsAtom)[draftKey] === undefined) return false;
  retargetNewTaskDraft(draftKey, project);
  return true;
}

export function useOpenNewTaskDraft() {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const selectDetail = useSelectWorkspaceDetail();
  return async (
    params: {
      environmentId: EnvironmentId;
      projectId: ProjectId;
      title: string;
      cloning?: "1";
      draftId?: string;
    },
    originRoute: NavigationState<ParamListBase>["routes"][number] | undefined,
  ) => {
    const isStillOnOrigin = () => {
      const activeRoute = getActiveRoute(navigation);
      // A warm link can change the task without replacing its native route key.
      return (
        originRoute !== undefined &&
        activeRoute?.key === originRoute.key &&
        activeRoute.name === originRoute.name &&
        activeRoute.params === originRoute.params
      );
    };
    if (!isStillOnOrigin()) return;
    const chooserDraft =
      params.draftId === undefined
        ? chooserDraftKey(
            navigation.getState()?.routes ?? [],
            (flowKey) => readNewTaskFlowState(flowKey).draftKey,
          )
        : null;
    const carried =
      chooserDraft !== null &&
      (await retargetSavedNewTaskDraft(chooserDraft, {
        environmentId: params.environmentId,
        projectId: params.projectId,
      }).catch(() => false));
    if (!isStillOnOrigin()) return;
    selectDetail({
      name: "Thread",
      params: { draft: carried ? { ...params, draftId: chooserDraft } : params },
    });
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
    void openNewTaskDraft(
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
    void openNewTaskDraft(
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
