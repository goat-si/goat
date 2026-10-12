import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { DEFAULT_SERVER_SETTINGS, type ScopedProjectRef, type ThreadId } from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
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
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  readProjects,
  readThreadShell,
  readThreadShells,
  useProjects,
  useThreadShell,
} from "../state/entities";
import {
  hasExplicitComposerModelSelection,
  resolveNewDraftStartFromOrigin,
  resolveNewThreadModelSelectionOverride,
} from "../lib/chatThreadActions";
import { readT3ProjectFile } from "../lib/t3ProjectFileDefaults";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

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

export function useNewThreadHandler() {
  const environmentServerConfigs = useAtomValue(environmentServerConfigsAtom);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        sshDestination?: DraftSshDestination | null;
        startFromOrigin?: boolean;
        replace?: boolean;
      },
      // Which draft the thread ended up in, so a caller that has something to put in it — a
      // prepared checkout, a task to write — addresses that one rather than looking the project
      // up again and finding whichever draft it happens to hold.
    ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
      const projects = readProjects();
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
      const requestingRouteHref = router.state.location.href;
      const routeChangedSinceRequest = () => router.state.location.href !== requestingRouteHref;
      const currentRouteTarget = getCurrentRouteTarget();
      // A new thread carries the user's working mode from the thread being
      // viewed. The target project's configured model still wins; interaction
      // mode carries independently. Permissions, branch, worktree, and env mode
      // come from configured defaults unless the caller passes them explicitly.
      const carrySourceShell =
        currentRouteTarget?.kind === "server"
          ? readThreadShell(currentRouteTarget.threadRef)
          : null;
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
      const carryModelSelection =
        composerModelSelection ?? carrySourceShell?.modelSelection ?? null;
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
      // The shared resolver owns the priority order. The t3.json read is
      // skipped entirely when a higher-priority source decides, and its
      // query atom caches per project after the first call.
      const resolveDefaultEnvMode = async (): Promise<DraftThreadEnvMode> => {
        const consultProjectFile =
          project !== undefined && projectSettings.settings.defaultThreadEnvMode === null;
        const projectFile = consultProjectFile
          ? await readT3ProjectFile(project.environmentId, project.workspaceRoot)
          : null;
        return resolveNewThreadEnvMode({
          projectSettings: resolveProjectSettings(
            targetServerSettings,
            project?.id ?? null,
            project,
            projectFile,
          ),
          workspaceRoot: project?.workspaceRoot ?? null,
          newProjectsRoot: environmentServerConfigs.get(projectRef.environmentId)?.newProjectsRoot,
          projectHasThreads: readThreadShells().some(
            (thread) =>
              thread.environmentId === projectRef.environmentId &&
              thread.projectId === projectRef.projectId,
          ),
        });
      };
      const resolveRequestedWorkspaceContext = async (): Promise<NewThreadWorkspaceOptions> => {
        if (
          options?.branch !== undefined ||
          options?.worktreePath !== undefined ||
          options?.envMode !== undefined ||
          options?.startFromOrigin !== undefined ||
          options?.sshDestination !== undefined
        )
          return pickExplicitWorkspaceOptions(options);
        const defaultEnvMode = await resolveDefaultEnvMode();
        return {
          branch: null,
          worktreePath: null,
          envMode: defaultEnvMode,
          sshDestination: null,
          startFromOrigin: resolveNewDraftStartFromOrigin({
            envMode: defaultEnvMode,
            newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
          }),
        };
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
      if (emptyStoredDraftThread) {
        return (async () => {
          const isDraftAlreadyOpen =
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === emptyStoredDraftThread.draftId;
          // Deliberate new-thread requests reset empty drafts, including an
          // already-open one. State written while defaults load wins instead.
          const initialWorkspaceContext = pickExplicitWorkspaceOptions(emptyStoredDraftThread);
          const workspaceContext = await resolveRequestedWorkspaceContext();
          if (routeChangedSinceRequest()) return null;
          const routeTargetNow = getCurrentRouteTarget();
          const openedMeanwhile =
            !isDraftAlreadyOpen &&
            routeTargetNow?.kind === "draft" &&
            routeTargetNow.draftId === emptyStoredDraftThread.draftId;
          const currentMappedDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
          const currentDraft = getDraftSession(emptyStoredDraftThread.draftId);
          const promotedMeanwhile =
            currentDraft == null ||
            currentDraft.promotedTo != null ||
            (storedDraftThreadRef !== null && readThreadShell(storedDraftThreadRef) !== null);
          const remappedMeanwhile =
            currentMappedDraft?.draftId !== emptyStoredDraftThread.draftId ||
            currentDraft?.environmentId !== emptyStoredDraftThread.environmentId ||
            currentDraft?.projectId !== emptyStoredDraftThread.projectId ||
            currentDraft?.threadId !== emptyStoredDraftThread.threadId;
          const investedMeanwhile = composerDraftHasUserContent(
            getComposerDraft(emptyStoredDraftThread.draftId),
          );
          const workspaceChangedMeanwhile =
            currentDraft != null &&
            workspaceSelectionChanged(
              initialWorkspaceContext,
              pickExplicitWorkspaceOptions(currentDraft),
            );
          if (
            openedMeanwhile ||
            promotedMeanwhile ||
            remappedMeanwhile ||
            investedMeanwhile ||
            workspaceChangedMeanwhile
          )
            return null;
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
          // The workspace context must also ride along here: when projectRef
          // targets a different physical member of the logical project,
          // createDraftThreadState treats the remap as a project change and
          // would otherwise wipe branch/worktree, undoing the write above.
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
          const opened = {
            draftId: emptyStoredDraftThread.draftId,
            threadId: emptyStoredDraftThread.threadId,
          };
          // Re-read the route: the snapshot from before the await is stale
          // once a concurrent invocation's navigation lands, and navigating
          // again would push a duplicate history entry.
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
          const initialWorkspaceContext = pickExplicitWorkspaceOptions(latestActiveDraftThread);
          const workspaceContext = await resolveRequestedWorkspaceContext();
          if (routeChangedSinceRequest()) return null;
          const activeNow = getDraftSession(currentRouteTarget.draftId);
          if (
            activeNow == null ||
            activeNow.promotedTo != null ||
            activeNow.logicalProjectKey !== logicalProjectKey ||
            activeNow.environmentId !== latestActiveDraftThread.environmentId ||
            activeNow.projectId !== latestActiveDraftThread.projectId ||
            activeNow.threadId !== latestActiveDraftThread.threadId ||
            workspaceSelectionChanged(
              initialWorkspaceContext,
              pickExplicitWorkspaceOptions(activeNow),
            ) ||
            readThreadShell(scopeThreadRef(activeNow.environmentId, activeNow.threadId)) !== null ||
            composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
          )
            return null;
          const mappedNow = getDraftSessionByLogicalProjectKey(logicalProjectKey);
          if (mappedNow && mappedNow.draftId !== currentRouteTarget.draftId) return null;
          setDraftThreadContext(currentRouteTarget.draftId, workspaceContext);
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            currentRouteTarget.draftId,
            {
              threadId: latestActiveDraftThread.threadId,
              createdAt: latestActiveDraftThread.createdAt,
              runtimeMode: latestActiveDraftThread.runtimeMode,
              interactionMode: latestActiveDraftThread.interactionMode,
              ...workspaceContext,
            },
          );
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
        const initialEnvMode = options?.envMode ?? (await resolveDefaultEnvMode());
        if (routeChangedSinceRequest()) {
          return null;
        }
        // The await yields, so a concurrent invocation may have registered a
        // draft for this logical project in the meantime. Registering ours
        // too would evict that draft while its navigation is in flight —
        // reuse the winner instead, like the synchronous path above does.
        const racedDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
        if (
          racedDraft &&
          // Only a draft REGISTERED during the await counts as a raced
          // winner. An invested draft this invocation deliberately declined
          // to reuse is still mapped at this point — reusing it here would
          // silently undo mint-fresh semantics.
          racedDraft.draftId !== storedDraftThread?.draftId &&
          readThreadShell(scopeThreadRef(racedDraft.environmentId, racedDraft.threadId)) === null
        ) {
          // Same remap the reuse paths above perform: point the draft at the
          // caller's project member and apply explicit workspace options if
          // the caller passed any. Without explicit options the winner's
          // context stands untouched — the winner's navigation is landing,
          // so this is a concurrent winner, not a new request. Writing
          // this invocation's defaults here instead would clobber the
          // winner's explicit picks and could pair its worktreePath with a
          // contradictory envMode.
          setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, racedDraft.draftId, {
            threadId: racedDraft.threadId,
            createdAt: racedDraft.createdAt,
            runtimeMode: racedDraft.runtimeMode,
            interactionMode: racedDraft.interactionMode,
            ...pickExplicitWorkspaceOptions(options),
          });
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: racedDraft.draftId },
            replace: options?.replace ?? false,
          });
          return { draftId: racedDraft.draftId, threadId: racedDraft.threadId };
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: initialEnvMode,
          sshDestination: options?.sshDestination ?? null,
          startFromOrigin:
            options?.startFromOrigin ??
            resolveNewDraftStartFromOrigin({
              envMode: initialEnvMode,
              newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
            }),
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
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace: options?.replace ?? false,
        });
        return { draftId, threadId };
      })();
    },
    [environmentServerConfigs, getCurrentRouteTarget, projectGroupingSettings, router],
  );
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const activeThread = useThreadShell(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadHandler();

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  };
}
