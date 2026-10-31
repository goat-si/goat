import { ActiveNewTaskContext } from "../../state/active-new-task";
import * as Dialog from "../../components/ui/Dialog";
import React, { useCallback, useEffect, useMemo } from "react";

import type {
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  ProviderOptionSelection,
  RuntimeMode,
  ServerProvider,
} from "@goat/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  repositoryGroupingKeyOf,
  ThreadId,
} from "@goat/contracts";
import { threadContextsOutsideEnvironment } from "@goat/shared/composerContextReferences";
import { useThreadContextHosts } from "../../lib/useThreadContextHosts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";

import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import type { TurnCommandMetadata } from "../../lib/commandMetadata";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import {
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
  resolveSelectableModelSelection,
} from "../../lib/modelOptions";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  appendComposerDraftAttachments,
  type ComposerDraftInsertion,
  type ComposerDraftWorkspaceSelection,
  clearComposerDraft,
  createNewTaskDraft,
  getComposerDraftSnapshot,
  isComposerDraftEmpty,
  isNewTaskDraftKey,
  removeComposerDraftAttachment,
  replaceComposerDraftAttachments,
  retargetNewTaskDraft,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerDraftText,
  setComposerDraftContext,
  setStickyComposerModelSelection,
  updateComposerDraftSettings,
  useComposerDraft,
  useStickyComposerModelSelection,
} from "../../state/use-composer-drafts";
import {
  capturePendingTaskEditorWriteBaseline,
  flushPendingTaskEditorWrite,
} from "../../state/pending-task-editor-writes";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import { useBranches, usePaginatedBranches } from "../../state/queries";
import { vcsEnvironment } from "../../state/vcs";
import {
  flattenQueuedThreadMessages,
  threadOutboxManager,
  type QueuedThreadMessage,
} from "../../state/thread-outbox";
import {
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
  useThreadOutboxMessages,
} from "../../state/use-thread-outbox";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { availableScratchWorkspaceRoot } from "@goat/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { EnvironmentProject } from "@goat/client-runtime/state/shell";
import { type VcsRef } from "@goat/client-runtime/state/vcs";
import {
  buildHomeProjectScopes,
  sortHomeProjectScopes,
  type HomeProjectScope,
} from "../home/homeThreadList";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import {
  resolvePendingTaskInteractionMode,
  resolveProviderInteractionMode,
} from "../../state/legacy-plan-mode";
import { useLegacyPlanModeState } from "./use-legacy-plan-mode-enabled";
import {
  resolveNewTaskBranchWorktreePath,
  resolveNewTaskDraftWorkspace,
} from "./new-task-context-presentation";
import { resolveEnvironmentProjectMatch } from "./new-task-project-selection";
import { useNewTaskRouteFlow } from "./use-new-task-route-flow";
import { useNewTaskProjectDefaults } from "./use-new-task-project-defaults";
import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";

type WorkspaceMode = "local" | "worktree";

function pendingTaskDraftKey(messageId: string): string {
  return `pending-task:${messageId}`;
}

// Track ownership across providers so old unmount flushes cannot drop newer drafts or drain locks.
let activeEditingMessageId: string | null = null;

function findQueuedPendingTask(messageId: string): QueuedThreadMessage | null {
  const message = flattenQueuedThreadMessages(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).find((candidate) => candidate.messageId === messageId);
  return message?.creation !== undefined ? message : null;
}

export function branchBadgeLabel(input: {
  readonly branch: VcsRef;
  readonly project: EnvironmentProject | null;
}): string | null {
  if (input.branch.current) {
    return "current";
  }
  if (input.branch.worktreePath && input.branch.worktreePath !== input.project?.workspaceRoot) {
    return "worktree";
  }
  if (input.branch.isRemote) {
    return "remote";
  }
  if (input.branch.isDefault) {
    return "default";
  }
  return null;
}

type NewTaskFlowContextValue = {
  readonly activeNewTask: { readonly pendingKey: string | null } | null;
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly selectedModelKey: string | null;
  readonly workspaceMode: WorkspaceMode;
  readonly isGitRepo: boolean;
  readonly isGitRepoKnown: boolean;
  readonly canChooseWorkspace: boolean;
  readonly resolveWorkspaceSelection: (
    selection: ComposerDraftWorkspaceSelection | undefined,
  ) => ComposerDraftWorkspaceSelection;
  readonly selectedBranchName: string | null;
  readonly selectedWorktreePath: string | null;
  readonly startFromOrigin: boolean;
  readonly pullRequestReference: string | undefined;
  readonly draftKey: string | null;
  readonly editingPendingTask: QueuedThreadMessage | null;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly submitting: boolean;
  readonly branchesLoading: boolean;
  readonly availableBranches: ReadonlyArray<VcsRef>;
  readonly currentCheckoutBranchName: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly planModeEnabled: boolean;
  readonly expandedProvider: string | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  }>;
  readonly selectedProject: EnvironmentProject | null;
  readonly isScratchDraft: boolean;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly selectedModel: ModelSelection | null;
  readonly selectedModelOption: ModelOption | null;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly flowKey: string;
  readonly missingRouteDraftId: string | null;
  readonly setProject: (project: EnvironmentProject) => void;
  readonly getSelectedProjectKey: () => string | null;
  readonly selectEnvironment: (environmentId: EnvironmentId) => void;
  readonly switchEnvironment: (environmentId: EnvironmentId) => Promise<boolean>;
  readonly switchingToEnvironmentId: EnvironmentId | null;
  readonly setSelectedModelKey: (
    key: string | null,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
  readonly setWorkspaceMode: (mode: WorkspaceMode) => void;
  readonly selectBranch: (branch: VcsRef) => void;
  readonly setStartFromOrigin: (value: boolean) => void;
  readonly beginEditingPendingTask: (messageId: string) => boolean;
  readonly finishEditingPendingTask: () => void;
  readonly cancelEditingPendingTask: () => void;
  readonly buildPendingTaskMessage: (
    metadata: TurnCommandMetadata,
    options?: {
      readonly currentCheckoutBranch?: string | null;
    },
  ) => QueuedThreadMessage | null;
  readonly setPrompt: (value: string) => void;
  readonly replaceAttachments: (attachments: ReadonlyArray<DraftComposerAttachment>) => void;
  /** Appends draft attachments; returns how many the live cap rejected. */
  readonly appendAttachments: (
    attachments: ReadonlyArray<DraftComposerAttachment>,
    insertion?: ComposerDraftInsertion,
  ) => number;
  readonly removeAttachment: (imageId: string) => void;
  readonly clearAttachments: () => void;
  readonly setSubmitting: (value: boolean) => void;
  readonly loadBranches: () => void;
  readonly setRuntimeMode: (value: RuntimeMode) => void;
  readonly setInteractionMode: (value: ProviderInteractionMode) => void;
  readonly setSelectedModelOptions: (
    value: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) => void;
  readonly setExpandedProvider: (value: string | null) => void;
};

const NewTaskFlowContext = React.createContext<NewTaskFlowContextValue | null>(null);

export function NewTaskFlowProvider(
  props: React.PropsWithChildren<{
    active?: boolean;
    flowKey?: string;
    routeDraftId?: string;
    routePendingTaskId?: string;
  }>,
) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const groupingSettings = useMobileProjectGroupingSettings();
  const { enabled: legacyPlanModeEnabled, loaded: planModePreferenceLoaded } =
    useLegacyPlanModeState();

  const projectScopes = sortHomeProjectScopes({
    scopes: buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: groupingSettings.sidebarProjectGroupingMode,
    }),
    threads,
    pendingTasks: [],
    projectSortOrder: "updated_at",
  });

  const routeFlow = useNewTaskRouteFlow(props, projects);
  const { flowKey, state: flowState, read: readFlow, update: updateFlow } = routeFlow;
  const {
    environmentId: selectedEnvironmentIdOverride,
    projectKey: selectedProjectKey,
    draftKey: activeDraftKey,
    submitting,
    expandedProvider,
    editingPendingTask,
    switchingToEnvironmentId,
  } = flowState;
  const setSelectedEnvironmentId = (environmentId: EnvironmentId | null) =>
    updateFlow({ environmentId });
  const setSelectedProjectKey = (projectKey: string | null) => updateFlow({ projectKey });
  const setActiveDraftKey = (draftKey: string | null) => updateFlow({ draftKey });
  const setSubmitting = (submitting: boolean) => updateFlow({ submitting });
  const setExpandedProvider = (expandedProvider: string | null) => updateFlow({ expandedProvider });
  const setEditingPendingTask = (editingPendingTask: QueuedThreadMessage | null) =>
    updateFlow({ editingPendingTask });
  const selectedEnvironmentId = selectedEnvironmentIdOverride ?? projects[0]?.environmentId ?? null;
  const editor = useMemo(
    () => ({
      flowKey,
      message: React.createRef<QueuedThreadMessage | null>(),
      revision: { current: Promise.resolve(0) },
      flush: React.createRef<(() => void) | null>(),
    }),
    [flowKey],
  );
  const {
    message: editingPendingTaskRef,
    revision: editingRevisionRef,
    flush: editingFlushRef,
  } = editor;

  const projectsForEnvironment = pipe(
    projects,
    Arr.filter((project) => project.environmentId === selectedEnvironmentId),
  );

  const editingPendingProject = ((): EnvironmentProject | null => {
    const creation = editingPendingTask?.creation;
    if (!editingPendingTask || !creation) {
      return null;
    }
    return {
      environmentId: editingPendingTask.environmentId,
      id: creation.projectId,
      title: creation.projectTitle ?? "Unknown project",
      workspaceRoot: creation.projectCwd ?? "",
      repositoryIdentity: null,
      defaultModelSelection: editingPendingTask.modelSelection ?? null,
      scripts: [],
      createdAt: editingPendingTask.createdAt,
      updatedAt: editingPendingTask.createdAt,
    };
  })();

  const selectedProject =
    routeFlow.pending || routeFlow.missingRouteDraftId !== null
      ? null
      : (projectsForEnvironment.find(
          (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
        ) ??
        // Pin queued edits to their original project when its shell is missing; fallback would silently retarget them.
        (editingPendingProject !== null &&
        selectedProjectKey ===
          scopedProjectKey(editingPendingProject.environmentId, editingPendingProject.id)
          ? editingPendingProject
          : selectedProjectKey === null
            ? (projectsForEnvironment[0] ?? null)
            : null));

  const verifiedThreadHosts = useThreadContextHosts(selectedProject?.environmentId ?? null);
  const storedStickyModelSelection = useStickyComposerModelSelection();
  const projectDefaults = useNewTaskProjectDefaults(selectedProject);
  const selectedEnvironmentServerConfig = projectDefaults.serverConfig;
  const isScratchDraft = projectDefaults.isScratch;
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const selectedProjectDraftKey = editingPendingTask
    ? pendingTaskDraftKey(editingPendingTask.messageId)
    : selectedProject
      ? activeDraftKey
      : null;

  useEffect(() => {
    if (
      props.active === false ||
      props.routeDraftId !== undefined ||
      props.routePendingTaskId !== undefined ||
      activeDraftKey !== null ||
      editingPendingTask !== null ||
      selectedProject === null
    ) {
      return;
    }
    setActiveDraftKey(
      createNewTaskDraft({
        environmentId: selectedProject.environmentId,
        projectId: selectedProject.id,
      }),
    );
  }, [
    activeDraftKey,
    editingPendingTask,
    selectedProject,
    props.active,
    props.routeDraftId,
    props.routePendingTaskId,
    setActiveDraftKey,
  ]);
  const activePendingKey =
    props.active === false
      ? null
      : props.routePendingTaskId
        ? `pending-task:${props.routePendingTaskId}`
        : props.routeDraftId
          ? `draft-task:${props.routeDraftId}`
          : editingPendingTask
            ? `pending-task:${editingPendingTask.messageId}`
            : selectedProjectDraftKey
              ? `draft-task:${selectedProjectDraftKey}`
              : null;
  const activeNewTask = React.useMemo(
    () => (props.active === false ? null : { pendingKey: activePendingKey }),
    [props.active, activePendingKey],
  );
  const selectedProjectDraft = useComposerDraft(selectedProjectDraftKey);
  const prompt = selectedProjectDraft.text;
  const attachments = selectedProjectDraft.attachments;
  const projectGitStatus = useEnvironmentQuery(
    selectedProject !== null && selectedProject.workspaceRoot !== ""
      ? vcsEnvironment.status({
          environmentId: selectedProject.environmentId,
          input: { cwd: selectedProject.workspaceRoot },
        })
      : null,
  );
  const currentCheckoutBranchName = projectGitStatus.data?.refName ?? null;
  // The unfiltered ref list also provides repository capability while offline.
  const projectBranches = useBranches({
    environmentId: selectedProject?.environmentId ?? null,
    cwd: selectedProject?.workspaceRoot || null,
  });
  const knownIsGitRepo = projectGitStatus.data?.isRepo ?? projectBranches.data?.isRepo ?? null;
  const isGitRepo = knownIsGitRepo ?? true;
  const { projectSettings, defaultWorkspaceMode, defaultWorkspaceModeSettled } = projectDefaults;
  const canChooseWorkspace = !isScratchDraft;
  const branchState = usePaginatedBranches({
    environmentId: selectedProject?.environmentId ?? null,
    cwd: selectedProject?.workspaceRoot || null,
  });
  const branchesLoading = branchState.isPending && branchState.data === null;
  const allBranchRefs = branchState.refs;
  const availableBranches = pipe(
    allBranchRefs,
    Arr.filter((branch) => !branch.isRemote),
  );

  const resolveWorkspaceSelection = (selection: ComposerDraftWorkspaceSelection | undefined) =>
    resolveNewTaskDraftWorkspace({
      selection,
      canChooseWorkspace,
      defaultMode: defaultWorkspaceMode,
      defaultModeSettled: defaultWorkspaceModeSettled,
      isGitRepo,
      branches: allBranchRefs,
      projectCwd: selectedProject?.workspaceRoot ?? null,
    });
  const workspaceSelection = resolveWorkspaceSelection(selectedProjectDraft.workspaceSelection);
  const workspaceMode = workspaceSelection.mode;
  const selectedBranchName = workspaceSelection.branch;
  const selectedWorktreePath = workspaceSelection.worktreePath;
  // Keep the user's explicit choice separate from the resolved display value:
  // only the explicit flag is ever written back to the draft, so the resolved
  // value keeps tracking the server setting when the config loads late.
  const draftStartFromOrigin = selectedProjectDraft.workspaceSelection?.startFromOrigin;
  const startFromOrigin =
    isGitRepo && (draftStartFromOrigin ?? projectSettings.settings.newWorktreesStartFromOrigin);
  const defaultRuntimeMode = editingPendingTask
    ? (editingPendingTask.runtimeMode ?? DEFAULT_RUNTIME_MODE)
    : projectSettings.settings.defaultRuntimeMode;
  const runtimeMode = selectedProjectDraft.runtimeMode ?? defaultRuntimeMode;

  // Antigravity keeps unavailable selections so sign-out or a catalog change
  // cannot switch the user's model.
  const draftModelSelection = resolveSelectableModelSelection(
    selectedEnvironmentServerConfig,
    selectedProjectDraft.modelSelection ?? null,
    selectedProject?.id ?? null,
  );
  const projectDefaultModelSelection = resolveDefaultableModelSelection(
    selectedEnvironmentServerConfig,
    projectSettings.settings.defaultModelSelection,
    selectedProject?.id ?? null,
  );
  const stickyModelSelection = resolveDefaultableModelSelection(
    selectedEnvironmentServerConfig,
    storedStickyModelSelection,
    selectedProject?.id ?? null,
  );
  const modelOptions = buildModelOptions(
    selectedEnvironmentServerConfig,
    draftModelSelection ?? projectDefaultModelSelection ?? stickyModelSelection,
    undefined,
    selectedProject?.id ?? null,
  );

  const selectedModel = resolveNewTaskModelSelection({
    draftSelection: draftModelSelection,
    projectDefaultSelection: projectDefaultModelSelection,
    stickySelection: stickyModelSelection,
    modelOptions,
  });
  const selectedModelKey = selectedModel
    ? `${selectedModel.instanceId}:${selectedModel.model}`
    : null;

  const selectedModelOption =
    modelOptions.find(
      (option) =>
        selectedModel &&
        option.selection.instanceId === selectedModel.instanceId &&
        option.selection.model === selectedModel.model,
    ) ?? null;
  const selectedProviderStatus =
    selectedEnvironmentServerConfig?.providers.find(
      (provider) => provider.instanceId === selectedModel?.instanceId,
    ) ?? null;
  const planModeEnabled =
    legacyPlanModeEnabled && selectedProviderStatus?.showInteractionModeToggle !== false;
  const interactionMode = planModeEnabled
    ? (selectedProjectDraft.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE)
    : DEFAULT_PROVIDER_INTERACTION_MODE;
  const setSelectedModelKey = (
    key: string | null,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => {
    if (!key || !selectedProjectDraftKey) {
      return;
    }
    const option = modelOptions.find((candidate) => candidate.key === key);
    if (!option) {
      return;
    }
    const selection = withRememberedModelOptions(
      options ? { ...option.selection, options } : option.selection,
    );
    const provider = selectedEnvironmentServerConfig?.providers.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    updateComposerDraftSettings(selectedProjectDraftKey, {
      modelSelection: selection,
      ...(provider?.showInteractionModeToggle === false
        ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
        : {}),
    });
    setStickyComposerModelSelection(selection);
  };
  const setSelectedModelOptions = (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
    if (!selectedModel || !selectedProjectDraftKey) {
      return;
    }
    rememberModelOptions(selectedModel.instanceId, selectedModel.model, options ?? []);
    const nextSelection: ModelSelection = options
      ? { ...selectedModel, options }
      : {
          instanceId: selectedModel.instanceId,
          model: selectedModel.model,
        };
    updateComposerDraftSettings(selectedProjectDraftKey, {
      modelSelection: nextSelection,
    });
    setStickyComposerModelSelection(nextSelection);
  };

  const providerGroups = groupByProvider(modelOptions);
  const setPrompt = (value: string) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    setComposerDraftText(selectedProjectDraftKey, value);
  };
  const replaceAttachments = (nextAttachments: ReadonlyArray<DraftComposerAttachment>) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    replaceComposerDraftAttachments(selectedProjectDraftKey, nextAttachments);
  };
  const appendAttachments = (
    nextAttachments: ReadonlyArray<DraftComposerAttachment>,
    insertion?: ComposerDraftInsertion,
  ): number => {
    if (!selectedProjectDraftKey) {
      return 0;
    }
    return appendComposerDraftAttachments(selectedProjectDraftKey, nextAttachments, {
      appendReference: true,
      insertion,
    });
  };
  const removeAttachment = (imageId: string) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    removeComposerDraftAttachment(selectedProjectDraftKey, imageId);
  };
  const clearAttachments = () => {
    if (!selectedProjectDraftKey) {
      return;
    }
    replaceComposerDraftAttachments(selectedProjectDraftKey, []);
  };
  const carryDraftContentTo = (project: EnvironmentProject) => {
    const target = { environmentId: project.environmentId, projectId: project.id };
    const currentDraftKey = readFlow().draftKey;
    if (currentDraftKey !== null && isNewTaskDraftKey(currentDraftKey)) {
      retargetNewTaskDraft(currentDraftKey, target);
    } else if (!editingPendingTaskRef.current) {
      setActiveDraftKey(createNewTaskDraft(target));
    }
  };

  const setProject = (project: EnvironmentProject) => {
    carryDraftContentTo(project);
    updateFlow({
      environmentId: project.environmentId,
      projectKey: scopedProjectKey(project.environmentId, project.id),
    });
  };

  const selectEnvironment = (environmentId: EnvironmentId) => {
    const match = resolveEnvironmentProjectMatch(
      projects.filter((project) => project.environmentId === environmentId),
      selectedProject,
    );
    if (match) {
      carryDraftContentTo(match);
    }
    setSelectedEnvironmentId(environmentId);
    setSelectedProjectKey(match ? scopedProjectKey(match.environmentId, match.id) : null);
  };

  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const setSwitchingToEnvironmentId = (switchingToEnvironmentId: EnvironmentId | null) =>
    updateFlow({ switchingToEnvironmentId });
  const { request: latestSwitchRef } = useMemo(
    () => ({ flowKey, request: React.createRef<object | null>() }),
    [flowKey],
  );
  const switchEnvironment = async (environmentId: EnvironmentId): Promise<boolean> => {
    if (environmentId === selectedEnvironmentId) {
      latestSwitchRef.current = null;
      setSwitchingToEnvironmentId(null);
      return true;
    }
    if (!isScratchDraft) {
      selectEnvironment(environmentId);
      return true;
    }
    const request = {};
    latestSwitchRef.current = request;
    setSwitchingToEnvironmentId(environmentId);
    const result = await openScratch({ environmentId, input: {} });
    if (latestSwitchRef.current !== request) return false;
    latestSwitchRef.current = null;
    setSwitchingToEnvironmentId(null);
    if (result._tag === "Success") {
      setProject(result.value);
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not switch machine",
        error instanceof Error
          ? error.message
          : "The folder for threads without a project could not be created.",
      );
    }
    return false;
  };

  const setWorkspaceMode = (mode: WorkspaceMode) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    if (!selectedProject) {
      return;
    }
    updateComposerDraftSettings(selectedProjectDraftKey, {
      workspaceSelection: {
        mode,
        branch: mode === "local" ? null : selectedBranchName,
        worktreePath: mode === "local" ? null : selectedWorktreePath,
        ...(mode === "local" ? { followsCurrentCheckout: true } : {}),
        ...(draftStartFromOrigin !== undefined ? { startFromOrigin: draftStartFromOrigin } : {}),
      },
    });
  };

  const selectBranch = (branch: VcsRef) => {
    if (!selectedProject || !selectedProjectDraftKey) {
      return;
    }
    updateComposerDraftSettings(selectedProjectDraftKey, {
      workspaceSelection: {
        mode: workspaceMode,
        branch: branch.name,
        worktreePath: resolveNewTaskBranchWorktreePath({
          workspaceMode,
          projectCwd: selectedProject.workspaceRoot,
          branchWorktreePath: branch.worktreePath,
        }),
        ...(draftStartFromOrigin !== undefined ? { startFromOrigin: draftStartFromOrigin } : {}),
      },
    });
  };

  const setStartFromOrigin = (value: boolean) => {
    if (!selectedProjectDraftKey) {
      return;
    }
    updateComposerDraftSettings(selectedProjectDraftKey, {
      workspaceSelection: {
        mode: workspaceMode,
        branch: selectedProjectDraft.workspaceSelection?.branch ?? null,
        worktreePath: selectedProjectDraft.workspaceSelection?.worktreePath ?? null,
        followsCurrentCheckout: selectedProjectDraft.workspaceSelection?.followsCurrentCheckout,
        startFromOrigin: value,
      },
    });
  };

  const refreshBranches = branchState.refresh;
  const loadBranches = () => {
    if (!selectedProject) {
      return;
    }
    setPendingConnectionError(null);
    refreshBranches();
  };

  const setRuntimeMode = (value: RuntimeMode) => {
    if (selectedProjectDraftKey) {
      updateComposerDraftSettings(selectedProjectDraftKey, { runtimeMode: value });
    }
  };
  const setInteractionMode = (value: ProviderInteractionMode) => {
    if (selectedProjectDraftKey) {
      updateComposerDraftSettings(selectedProjectDraftKey, {
        interactionMode: resolveProviderInteractionMode(selectedProviderStatus, value),
      });
    }
  };

  const beginEditingPendingTask = (messageId: string): boolean => {
    const message = findQueuedPendingTask(messageId);
    if (!message?.creation) {
      return false;
    }
    const draftKey = pendingTaskDraftKey(message.messageId);
    if (isComposerDraftEmpty(getComposerDraftSnapshot(draftKey))) {
      setComposerDraftText(draftKey, message.text);
      setComposerDraftContext(draftKey, message.context);
      replaceComposerDraftAttachments(draftKey, message.attachments);
      updateComposerDraftSettings(draftKey, {
        modelSelection: message.modelSelection,
        runtimeMode: message.runtimeMode,
        interactionMode: message.interactionMode,
        workspaceSelection: {
          mode: message.creation.workspaceMode,
          branch: message.creation.branch,
          worktreePath: message.creation.worktreePath,
          startFromOrigin: message.creation.startFromOrigin ?? false,
          pullRequestReference: message.creation.pullRequestReference,
        },
      });
    }
    setSelectedEnvironmentId(message.environmentId);
    setSelectedProjectKey(scopedProjectKey(message.environmentId, message.creation.projectId));
    activeEditingMessageId = message.messageId;
    editingPendingTaskRef.current = message;
    editingRevisionRef.current = capturePendingTaskEditorWriteBaseline(message.messageId);
    setEditingPendingTask(message);
    holdEditingQueuedMessage(message.messageId);
    return true;
  };

  const buildPendingTaskMessage = (
    metadata: TurnCommandMetadata,
    options?: { readonly currentCheckoutBranch?: string | null },
  ): QueuedThreadMessage | null => {
    if (!selectedProject || !selectedProjectDraftKey) {
      return null;
    }
    const draft = getComposerDraftSnapshot(selectedProjectDraftKey);
    const text = draft.text.trim();
    const draftModelSelection =
      resolveSelectableModelSelection(
        selectedEnvironmentServerConfig,
        draft.modelSelection ?? null,
        selectedProject.id,
      ) ?? selectedModel;
    if ((text.length === 0 && draft.attachments.length === 0) || !draftModelSelection) {
      return null;
    }
    if (
      threadContextsOutsideEnvironment({
        text: draft.text,
        records: draft.context?.records ?? [],
        environmentId: selectedProject.environmentId,
        verifiedHosts: verifiedThreadHosts,
      }).length > 0
    ) {
      return null;
    }
    const workspaceSelection = resolveWorkspaceSelection(draft.workspaceSelection);
    const mode = workspaceSelection.mode;
    // When the selection is the stand-in built from the queued snapshot,
    // persist the original (possibly absent) snapshot values — the
    // stand-in's placeholder title/workspaceRoot must never be written back
    // as if they were real project metadata.
    const usingPendingSnapshot = selectedProject === editingPendingProject;
    const projectTitle = usingPendingSnapshot
      ? editingPendingTask?.creation?.projectTitle
      : selectedProject.title;
    const projectCwd = usingPendingSnapshot
      ? editingPendingTask?.creation?.projectCwd
      : selectedProject.workspaceRoot;
    return {
      environmentId: selectedProject.environmentId,
      threadId: ThreadId.make(metadata.threadId),
      messageId: MessageId.make(metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments: draft.attachments,
      context: draft.context,
      modelSelection: draftModelSelection,
      runtimeMode: draft.runtimeMode ?? defaultRuntimeMode,
      interactionMode: resolvePendingTaskInteractionMode({
        preferenceLoaded: planModePreferenceLoaded,
        planModeEnabled: legacyPlanModeEnabled,
        draftInteractionMode: draft.interactionMode,
        queuedInteractionMode: editingPendingTask?.interactionMode,
        provider: selectedEnvironmentServerConfig?.providers.find(
          (candidate) => candidate.instanceId === draftModelSelection.instanceId,
        ),
      }),
      creation: {
        projectId: selectedProject.id,
        ...(projectTitle !== undefined ? { projectTitle } : {}),
        ...(projectCwd !== undefined ? { projectCwd } : {}),
        workspaceMode: mode,
        ...(mode === "worktree" && workspaceSelection?.pullRequestReference
          ? { pullRequestReference: workspaceSelection.pullRequestReference }
          : {}),
        // Queued local tasks use drain-time checkout; snapshot branches only for immediate sends or explicit choices.
        branch: resolveProjectThreadCreationBranch({
          workspaceMode: mode,
          selectedBranch: workspaceSelection?.branch ?? null,
          currentCheckoutBranch: options?.currentCheckoutBranch ?? null,
        }),
        worktreePath: mode === "worktree" ? null : (workspaceSelection?.worktreePath ?? null),
        ...((workspaceSelection?.startFromOrigin ?? startFromOrigin)
          ? { startFromOrigin: true }
          : {}),
      },
      createdAt: metadata.createdAt,
    };
  };

  const finishEditingPendingTask = () => {
    const editing = editingPendingTaskRef.current;
    editingPendingTaskRef.current = null;
    if (editing) {
      if (activeEditingMessageId === editing.messageId) {
        activeEditingMessageId = null;
      }
      clearComposerDraft(pendingTaskDraftKey(editing.messageId));
      releaseEditingQueuedMessage(editing.messageId);
      scheduleUnusedComposerAttachmentCleanup(editing.attachments);
    }
    setEditingPendingTask(null);
  };

  // End editing without saving if the queued task disappears; a later flush must not resurrect it.
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  useEffect(() => {
    const editing = editingPendingTaskRef.current;
    if (!editing) {
      return;
    }
    const stillQueued = flattenQueuedThreadMessages(queuedMessagesByThreadKey).some(
      (candidate) => candidate.messageId === editing.messageId,
    );
    if (!stillQueued) {
      finishEditingPendingTask();
    }
  }, [editingPendingTaskRef, finishEditingPendingTask, queuedMessagesByThreadKey]);

  useEffect(() => {
    editingFlushRef.current = () => {
      const editing = editingPendingTaskRef.current;
      if (!editing) {
        return;
      }
      editingPendingTaskRef.current = null;
      setEditingPendingTask(null);
      if (activeEditingMessageId === editing.messageId) {
        activeEditingMessageId = null;
      }

      const message = buildPendingTaskMessage({
        threadId: editing.threadId,
        commandId: editing.commandId,
        messageId: editing.messageId,
        createdAt: editing.createdAt,
      });

      if (!message) {
        // Keep unsendable edits and the drain lock so removed content cannot auto-send from a stale payload.
        return;
      }

      // Hand off pending saves to reopened editors; CAS still rejects unrelated edits, deletes and deliveries.
      void flushPendingTaskEditorWrite({
        message,
        baseline: editingRevisionRef.current,
        draftKey: pendingTaskDraftKey(editing.messageId),
      })
        .then((savedDraftStillCurrent) => {
          if (activeEditingMessageId === editing.messageId) {
            return;
          }
          if (!savedDraftStillCurrent) {
            return;
          }
          clearComposerDraft(pendingTaskDraftKey(editing.messageId));
          releaseEditingQueuedMessage(editing.messageId);
          scheduleUnusedComposerAttachmentCleanup(editing.attachments);
        })
        .catch((error) => {
          // Keep the draft and drain lock on failure so stale payloads cannot discard edits; reopening retries.
          console.warn("[new-task] failed to save edited pending task", error);
        });
    };
  }, [
    buildPendingTaskMessage,
    editingFlushRef,
    editingPendingTaskRef,
    editingRevisionRef,
    setEditingPendingTask,
  ]);
  const cancelEditingPendingTask = useCallback(() => {
    editingFlushRef.current?.();
  }, [editingFlushRef]);
  useEffect(() => {
    return () => editor.flush.current?.();
  }, [editor]);
  const scratchEnvironments = connectedEnvironments.filter(
    (environment) =>
      availableScratchWorkspaceRoot(
        environment.connectionState,
        serverConfigs.get(environment.environmentId),
      ) !== null,
  );

  const selectedRepositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  // Use || null: placeholder workspaceRoot can be empty, and an empty basename rejects real hosts.
  const selectedWorkspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  const selectedProjectTitle = selectedProject?.title ?? null;
  const environments = (() => {
    if (isScratchDraft) {
      return scratchEnvironments.map((environment) => ({
        environmentId: environment.environmentId,
        environmentLabel: environment.environmentLabel,
      }));
    }
    const seen = new Set<EnvironmentId>();
    const result: Array<{
      readonly environmentId: EnvironmentId;
      readonly environmentLabel: string;
    }> = [];
    const hostsSelectedRepository = (project: EnvironmentProject) => {
      if (selectedRepositoryKey === null && selectedWorkspaceBasename === null) {
        return true;
      }
      const projectKey = project.repositoryIdentity
        ? repositoryGroupingKeyOf(project.repositoryIdentity)
        : null;
      if (selectedRepositoryKey !== null && projectKey !== null) {
        return projectKey === selectedRepositoryKey;
      }
      return (
        project.workspaceRoot.split("/").at(-1) === selectedWorkspaceBasename ||
        (selectedProjectTitle !== null && project.title === selectedProjectTitle)
      );
    };
    for (const project of projects) {
      if (!hostsSelectedRepository(project)) {
        continue;
      }
      if (seen.has(project.environmentId)) {
        continue;
      }
      const environment = savedConnectionsById[project.environmentId];
      if (!environment) {
        continue;
      }
      seen.add(project.environmentId);
      result.push({
        environmentId: project.environmentId,
        environmentLabel: environment.environmentLabel,
      });
    }
    return result;
  })();

  const value = {
    activeNewTask,
    projectScopes,
    selectedEnvironmentId,
    selectedProjectKey,
    selectedModelKey,
    workspaceMode,
    isGitRepo,
    isGitRepoKnown: knownIsGitRepo !== null,
    canChooseWorkspace,
    selectedBranchName,
    resolveWorkspaceSelection,
    selectedWorktreePath,
    startFromOrigin,
    draftKey: selectedProjectDraftKey,
    pullRequestReference: selectedProjectDraft.workspaceSelection?.pullRequestReference,
    editingPendingTask,
    prompt,
    attachments,
    submitting,
    branchesLoading,
    availableBranches,
    currentCheckoutBranchName,
    runtimeMode,
    interactionMode,
    planModeEnabled,
    expandedProvider,
    environments,
    selectedProject,
    isScratchDraft,
    modelOptions,
    selectedModel,
    selectedModelOption,
    selectedProviderStatus,
    providerGroups,
    flowKey,
    missingRouteDraftId: routeFlow.missingRouteDraftId,
    setProject,
    getSelectedProjectKey: () => readFlow().projectKey,
    selectEnvironment,
    switchEnvironment,
    switchingToEnvironmentId,
    setSelectedModelKey,
    setWorkspaceMode,
    selectBranch,
    setStartFromOrigin,
    beginEditingPendingTask,
    finishEditingPendingTask,
    cancelEditingPendingTask,
    buildPendingTaskMessage,
    setPrompt,
    replaceAttachments,
    appendAttachments,
    removeAttachment,
    clearAttachments,
    setSubmitting,
    loadBranches,
    setRuntimeMode,
    setInteractionMode,
    setSelectedModelOptions,
    setExpandedProvider,
  } satisfies NewTaskFlowContextValue;

  return (
    <ActiveNewTaskContext value={activeNewTask}>
      <NewTaskFlowContext.Provider value={value}>{props.children}</NewTaskFlowContext.Provider>
    </ActiveNewTaskContext>
  );
}

export function useNewTaskFlow() {
  const value = React.use(NewTaskFlowContext);
  if (value === null) {
    throw new Error("useNewTaskFlow must be used within NewTaskFlowProvider.");
  }
  return value;
}
