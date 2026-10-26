import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@goat/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  type GoatProjectFile,
  type ScopedProjectRef,
  type ThreadId,
} from "@goat/contracts";
import { useRouter } from "@tanstack/react-router";
import {
  composerDraftHasUserContent,
  markPromotedDraftThreadByRef,
  draftSshDestinationsEqual,
  type DraftSshDestination,
  type DraftId,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@goat/shared/projectSettings";
import {
  readProject,
  readProjects,
  readThreadShell,
  readThreadShells,
  useProjects,
  useQuietThreadShell,
} from "../state/entities";
import {
  hasExplicitComposerModelSelection,
  resolveNewDraftStartFromOrigin,
  resolveNewThreadEnvModeWithLastWork,
  resolveNewThreadModelSelectionOverride,
} from "../lib/chatThreadActions";
import { loadGoatProjectFile, peekGoatProjectFile } from "../lib/goatProjectFileDefaults";
import { draftWorkspacePickCount } from "../lib/draftWorkspacePicks";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";
import { useThreadRouteTarget } from "./useThreadRouteTarget";
import { readUnloadedThreadCount } from "../state/olderSettledShelf";

interface NewThreadWorkspaceOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  sshDestination?: DraftSshDestination | null;
  startFromOrigin?: boolean;
}

// The workspace options the caller passed explicitly, shaped for the draft
// store: absent keys stay absent so they never overwrite existing draft
// state. Every reuse path applies exactly this set.
function pickExplicitWorkspaceOptions(options: NewThreadWorkspaceOptions | undefined) {
  return {
    ...(options?.branch !== undefined ? { branch: options.branch } : {}),
    ...(options?.worktreePath !== undefined ? { worktreePath: options.worktreePath } : {}),
    ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
    ...(options?.sshDestination !== undefined ? { sshDestination: options.sshDestination } : {}),
    ...(options?.startFromOrigin !== undefined ? { startFromOrigin: options.startFromOrigin } : {}),
  };
}

/**
 * Whether the user picked a different workspace while a new-thread request was
 * resolving its defaults. The branch selector seeds an empty New worktree base
 * branch on its own (BranchToolbarBranchSelector's automatic setThreadBranch),
 * so filling a branch that was empty does not count as a choice; replacing one does.
 */
function workspaceSelectionChanged(
  initial: NewThreadWorkspaceOptions,
  current: NewThreadWorkspaceOptions,
): boolean {
  const branchReplaced =
    (initial.branch ?? null) !== null && (current.branch ?? null) !== (initial.branch ?? null);
  return (
    current.envMode !== initial.envMode ||
    current.worktreePath !== initial.worktreePath ||
    current.startFromOrigin !== initial.startFromOrigin ||
    !draftSshDestinationsEqual(current.sshDestination, initial.sshDestination) ||
    branchReplaced
  );
}

/**
 * Whether a branch appeared after the request wrote none. The branch selector seeds an empty New
 * worktree base on its own, so only a branch filled in outside worktree mode is a pick.
 */
function branchPickedSince(
  applied: NewThreadWorkspaceOptions,
  current: NewThreadWorkspaceOptions,
): boolean {
  return (
    (applied.branch ?? null) === null &&
    (current.branch ?? null) !== null &&
    applied.envMode !== "worktree"
  );
}

// A background project file read gives up instead of holding a mounted query while its
// environment stays unreachable.
const PROJECT_FILE_READ_TIMEOUT_MS = 30_000;

export function useNewThreadHandler() {
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const getCurrentRouteTarget = () => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  };

  return (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      lastWorkEnvMode?: DraftThreadEnvMode;
      sshDestination?: DraftSshDestination | null;
      startFromOrigin?: boolean;
      replace?: boolean;
    },
    // Which draft the thread ended up in, so a caller that has something to put in it — a
    // prepared checkout, a task to write — addresses that one rather than looking the project
    // up again and finding whichever draft it happens to hold.
  ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
    const projects = readProjects();
    // Read at call time; status pushes replace the config map and would recreate every sidebar handler.
    const environmentServerConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const targetServerSettings =
      environmentServerConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
    const {
      getComposerDraft,
      getDraftSessionByLogicalProjectKey,
      getDraftSession,
      getDraftThread,
      applyStickyState,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
      setModelSelection,
    } = useComposerDraftStore.getState();
    const currentRouteTarget = getCurrentRouteTarget();
    // A new thread carries the user's working mode from the thread being
    // viewed. The target project's configured model still wins; interaction
    // mode carries independently. Permissions, branch, worktree, and env mode
    // come from configured defaults unless the caller passes them explicitly.
    const carrySourceShell =
      currentRouteTarget?.kind === "server" ? readThreadShell(currentRouteTarget.threadRef) : null;
    const carrySourceDraft =
      currentRouteTarget?.kind === "draft" ? getDraftSession(currentRouteTarget.draftId) : null;
    // Composer overrides win over the persisted thread state — they are
    // what the user currently sees in the composer controls.
    const carrySourceComposer = currentRouteTarget
      ? getComposerDraft(
          currentRouteTarget.kind === "server"
            ? currentRouteTarget.threadRef
            : currentRouteTarget.draftId,
        )
      : null;
    const composerActiveProvider = carrySourceComposer?.activeProvider ?? null;
    const composerModelSelection = composerActiveProvider
      ? (carrySourceComposer?.modelSelectionByProvider[composerActiveProvider] ?? null)
      : null;
    const carryModelSelection = composerModelSelection ?? carrySourceShell?.modelSelection ?? null;
    const carryInteractionMode =
      carrySourceComposer?.interactionMode ??
      carrySourceShell?.interactionMode ??
      carrySourceDraft?.interactionMode ??
      null;
    const project = projects.find(
      (candidate) =>
        candidate.id === projectRef.projectId &&
        candidate.environmentId === projectRef.environmentId,
    );
    // The resolver applies project overrides and, until the server has
    // folded them, the aggregate's own legacy fields.
    const projectSettings = resolveProjectSettings(
      targetServerSettings,
      project?.id ?? null,
      project,
    );
    const projectDefaultModelSelection = projectSettings.settings.defaultModelSelection;
    const defaultRuntimeMode = projectSettings.settings.defaultRuntimeMode;
    const resolveModelSelectionOverride = (destinationDraftId: DraftId) =>
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: projectDefaultModelSelection ?? null,
        carrySelection: carryModelSelection,
        carrySourceDraftId:
          currentRouteTarget?.kind === "draft" ? currentRouteTarget.draftId : null,
        destinationDraftId,
      });
    // The shared resolver owns the priority order. The project file only matters when no
    // higher-priority source decides. Opening never waits for it: the last known file stands in
    // and refineFromProjectFile applies a fresh read that changes the answer.
    const consultProjectFile =
      project !== undefined && projectSettings.settings.defaultThreadEnvMode === null;
    const envModeForProjectFile = (projectFile: GoatProjectFile | null): DraftThreadEnvMode => {
      const finalProjectSettings = resolveProjectSettings(
        targetServerSettings,
        project?.id ?? null,
        project,
        projectFile,
      );
      const resolvedMode = resolveNewThreadEnvMode({
        projectSettings: finalProjectSettings,
        workspaceRoot: project?.workspaceRoot ?? null,
        newProjectsRoot: environmentServerConfigs.get(projectRef.environmentId)?.newProjectsRoot,
        projectHasThreads:
          readThreadShells().some(
            (thread) =>
              thread.environmentId === projectRef.environmentId &&
              thread.projectId === projectRef.projectId,
          ) ||
          readUnloadedThreadCount(
            [{ environmentId: projectRef.environmentId, id: projectRef.projectId }],
            [],
          ) > 0,
      });
      return resolveNewThreadEnvModeWithLastWork({
        resolvedSource: finalProjectSettings.sources.defaultThreadEnvMode,
        resolvedMode,
        lastWorkEnvMode: options?.lastWorkEnvMode,
      });
    };
    const cachedProjectFile =
      project !== undefined && consultProjectFile
        ? peekGoatProjectFile(project.environmentId, project.workspaceRoot)
        : null;
    const defaultEnvMode = envModeForProjectFile(
      cachedProjectFile?.known === true ? cachedProjectFile.file : null,
    );
    const startFromOriginFor = (envMode: DraftThreadEnvMode) =>
      resolveNewDraftStartFromOrigin({
        envMode,
        newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
      });
    const callerChoseWorkspace =
      options?.branch !== undefined ||
      options?.worktreePath !== undefined ||
      options?.envMode !== undefined ||
      options?.startFromOrigin !== undefined ||
      options?.sshDestination !== undefined;
    const requestedWorkspaceContext: NewThreadWorkspaceOptions = callerChoseWorkspace
      ? pickExplicitWorkspaceOptions(options)
      : {
          branch: null,
          worktreePath: null,
          envMode: defaultEnvMode,
          sshDestination: null,
          startFromOrigin: startFromOriginFor(defaultEnvMode),
        };
    const logicalProjectKey = project
      ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
      : scopedProjectKey(projectRef);
    const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
    const storedDraftThreadRef = storedDraftThread
      ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
      : null;
    const reusableStoredDraftThread =
      storedDraftThread !== null &&
      storedDraftThread.promotedTo == null &&
      storedDraftThreadRef !== null &&
      readThreadShell(storedDraftThreadRef) === null
        ? storedDraftThread
        : null;
    if (storedDraftThreadRef && reusableStoredDraftThread === null) {
      markPromotedDraftThreadByRef(storedDraftThreadRef);
    }
    // New-thread surfaces (button, hotkeys, "/" landing, palette) only
    // ever reuse a draft the user has NOT invested in. A draft with typed
    // text or attachments is work in progress: it stays alive where it is
    // (reachable from the sidebar draft rows) and this request mints a
    // fresh draft instead — the remap in the store preserves invested
    // drafts rather than deleting them.
    const emptyStoredDraftThread =
      reusableStoredDraftThread &&
      !composerDraftHasUserContent(getComposerDraft(reusableStoredDraftThread.draftId))
        ? reusableStoredDraftThread
        : null;
    const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
      ? currentRouteTarget.kind === "server"
        ? getDraftThread(currentRouteTarget.threadRef)
        : getDraftSession(currentRouteTarget.draftId)
      : null;
    // A fresh project file that changes the default lands only while the draft still holds what
    // this request wrote: a workspace pick, a send, or a later request owns it from then on.
    const refineFromProjectFile = (
      draftId: DraftId,
      threadId: ThreadId,
      applied: NewThreadWorkspaceOptions,
      keepStartFromOrigin: boolean,
    ) => {
      if (project === undefined || !consultProjectFile) return;
      const picksAtRequest = draftWorkspacePickCount(draftId);
      void loadGoatProjectFile(project.environmentId, project.workspaceRoot, {
        signal: AbortSignal.timeout(PROJECT_FILE_READ_TIMEOUT_MS),
      }).then((lookup) => {
        if (!lookup.known) return;
        const envMode = envModeForProjectFile(lookup.file);
        if (envMode === applied.envMode) return;
        const draftStore = useComposerDraftStore.getState();
        const draft = draftStore.getDraftSession(draftId);
        if (
          draft == null ||
          draft.promotedTo != null ||
          draft.threadId !== threadId ||
          draft.environmentId !== projectRef.environmentId ||
          draft.projectId !== projectRef.projectId ||
          draftStore.getDraftSessionByLogicalProjectKey(logicalProjectKey)?.draftId !== draftId ||
          readThreadShell(scopeThreadRef(draft.environmentId, threadId)) !== null ||
          readProject(projectRef) === null ||
          draftWorkspacePickCount(draftId) !== picksAtRequest ||
          workspaceSelectionChanged(applied, pickExplicitWorkspaceOptions(draft)) ||
          branchPickedSince(applied, draft)
        ) {
          return;
        }
        draftStore.setDraftThreadContext(draftId, {
          envMode,
          ...(keepStartFromOrigin ? {} : { startFromOrigin: startFromOriginFor(envMode) }),
          // A seeded New worktree base means nothing for a local thread, and a worktree
          // thread gets a fresh seed.
          ...((applied.branch ?? null) === null ? { branch: null } : {}),
        });
      });
    };
    if (emptyStoredDraftThread) {
      return (async () => {
        const isDraftAlreadyOpen =
          currentRouteTarget?.kind === "draft" &&
          currentRouteTarget.draftId === emptyStoredDraftThread.draftId;
        // Deliberate new-thread requests reset empty drafts, including an
        // already-open one.
        const workspaceContext = requestedWorkspaceContext;
        setDraftThreadContext(emptyStoredDraftThread.draftId, {
          ...workspaceContext,
          ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
          ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
        });
        // Model intent: an explicit human pick always stands. Seeds and
        // legacy entries alike re-resolve here — sticky first, mirroring
        // the mint-fresh path, then the project default or carried
        // selection on top. This runs even when the draft is already open:
        // without it, a changed pin could never reach the draft the user
        // is looking at, because explicit picks are the only thing the
        // flag protects.
        const storedDraft = getComposerDraft(emptyStoredDraftThread.draftId);
        const storedDraftHasExplicitModelPick = hasExplicitComposerModelSelection(storedDraft);
        if (!storedDraftHasExplicitModelPick) {
          applyStickyState(emptyStoredDraftThread.draftId);
          const modelSelectionOverride = resolveModelSelectionOverride(
            emptyStoredDraftThread.draftId,
          );
          if (modelSelectionOverride) {
            // This is a complete snapshot: absent options mean "no options",
            // not "keep the stale draft's options".
            setModelSelection(emptyStoredDraftThread.draftId, modelSelectionOverride, {
              replaceOptions: true,
            });
          }
        }
        // Remapping physical projects clears workspace context; preserve the branch and worktree.
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          projectRef,
          emptyStoredDraftThread.draftId,
          {
            threadId: emptyStoredDraftThread.threadId,
            ...workspaceContext,
            ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
            ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
          },
        );
        if (!callerChoseWorkspace) {
          refineFromProjectFile(
            emptyStoredDraftThread.draftId,
            emptyStoredDraftThread.threadId,
            workspaceContext,
            false,
          );
        }
        const opened = {
          draftId: emptyStoredDraftThread.draftId,
          threadId: emptyStoredDraftThread.threadId,
        };
        // Navigating to the draft already on screen would push a duplicate history entry.
        const routeTargetAfterWrites = getCurrentRouteTarget();
        if (
          routeTargetAfterWrites?.kind === "draft" &&
          routeTargetAfterWrites.draftId === emptyStoredDraftThread.draftId
        ) {
          return opened;
        }
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId: emptyStoredDraftThread.draftId },
          replace: options?.replace ?? false,
        });
        return opened;
      })();
    }

    if (
      latestActiveDraftThread &&
      currentRouteTarget?.kind === "draft" &&
      latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
      latestActiveDraftThread.promotedTo == null &&
      // Same content rule as above: a new-thread request while viewing an
      // invested draft mints a fresh one instead of repurposing it.
      !composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
    ) {
      return (async () => {
        const mappedNow = getDraftSessionByLogicalProjectKey(logicalProjectKey);
        if (mappedNow && mappedNow.draftId !== currentRouteTarget.draftId) return null;
        const workspaceContext = requestedWorkspaceContext;
        setDraftThreadContext(currentRouteTarget.draftId, workspaceContext);
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...workspaceContext,
        });
        if (!callerChoseWorkspace) {
          refineFromProjectFile(
            currentRouteTarget.draftId,
            latestActiveDraftThread.threadId,
            workspaceContext,
            false,
          );
        }
        return {
          draftId: currentRouteTarget.draftId,
          threadId: latestActiveDraftThread.threadId,
        };
      })();
    }

    const draftId = newDraftId();
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    return (async () => {
      const initialEnvMode = options?.envMode ?? defaultEnvMode;
      const startFromOrigin = options?.startFromOrigin ?? startFromOriginFor(initialEnvMode);
      setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
        threadId,
        createdAt,
        branch: options?.branch ?? null,
        worktreePath: options?.worktreePath ?? null,
        envMode: initialEnvMode,
        sshDestination: options?.sshDestination ?? null,
        startFromOrigin,
        runtimeMode: defaultRuntimeMode,
        ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
      });
      applyStickyState(draftId);
      const modelSelectionOverride = resolveModelSelectionOverride(draftId);
      if (modelSelectionOverride) {
        // Project defaults and carried selections both outrank global sticky
        // state. The project default wins when both are present.
        setModelSelection(draftId, modelSelectionOverride, { replaceOptions: true });
      }
      if (options?.envMode === undefined) {
        refineFromProjectFile(
          draftId,
          threadId,
          {
            branch: options?.branch ?? null,
            worktreePath: options?.worktreePath ?? null,
            envMode: initialEnvMode,
            sshDestination: options?.sshDestination ?? null,
            startFromOrigin,
          },
          options?.startFromOrigin !== undefined,
        );
      }
      await router.navigate({
        to: "/draft/$draftId",
        params: { draftId },
        replace: options?.replace ?? false,
      });
      return { draftId, threadId };
    })();
  };
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useThreadRouteTarget();
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const activeThread = useQuietThreadShell(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const handleNewThread = useNewThreadHandler();
  const [defaultProject] = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const defaultProjectRef = defaultProject
    ? scopeProjectRef(defaultProject.environmentId, defaultProject.id)
    : null;

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  };
}
