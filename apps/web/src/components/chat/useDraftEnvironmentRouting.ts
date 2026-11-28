import { useLoadBalancedEnvironment } from "../../hooks/useLoadBalancedEnvironment";
import { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { MachineWithoutProject } from "../../lib/runOnArrival";
import { cloneForRunOn } from "../../lib/runOnClone";
import { newProjectId } from "../../lib/utils";
import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import {
  type EnvironmentId,
  type ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ScopedProjectRef,
  type ThreadContextRecord,
} from "@goat/contracts";
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@goat/client-runtime/environment";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { shallow } from "zustand/shallow";
import { toastManager } from "../ui/toast";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { readProject, readProjects, subscribeProjects, useProjects } from "../../state/entities";
import { unsilenceProjectCloneToasts } from "../../state/projectClones";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import type { DraftSessionState } from "../../composerDraftStore";
import { loadBalancingSendWarning } from "./composerSend.logic";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { trackPendingWorkspaceDefault } from "../../lib/draftWorkspaceDefaults";
import { retargetDraftWorkspace } from "../../lib/retargetDraftWorkspace";
import { resolveDefaultWorktreeBaseBranch } from "../BranchToolbar.logic";
import { draftFanoutSelectionsAtom } from "./chatViewSend";

interface DraftEnvironmentRoutingInput {
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly envLocked: boolean;
  readonly automaticEnvironment: boolean;
  readonly logicalProjectEnvironments: ReturnType<typeof useLogicalProjectEnvironments>;
  /** Machines without the project; picking one that can clone it brings the project there. */
  readonly machinesWithoutProject: readonly MachineWithoutProject[];
  readonly activeProject: EnvironmentProject | null;
  readonly environmentById: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly providersByEnvironment: ReturnType<typeof useEnvironmentProviders>;
  readonly loadBalancingSettings: {
    readonly loadBalancingWeights: Readonly<Record<string, number>>;
  };
  readonly referencedThreadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly selectedProvider: ProviderDriverKind;
  readonly composerHasAttachments: boolean;
  readonly activeProjectKey: string | null;
  readonly activeProjectIsScratch: boolean;
  readonly projectGroupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
  readonly sendInFlightRef: { readonly current: boolean };
}

const WORKTREE_BASE_TIMEOUT_MS = 5_000;

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? null : value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      },
    );
  });
}

function withAbortTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return run(controller.signal).finally(() => clearTimeout(timer));
}

// A send waits on this; a read stuck on a reconnecting machine falls back to no project file.
function readDestinationWorkspace(draft: DraftSessionState, projectRef: ScopedProjectRef) {
  return retargetDraftWorkspace(draft, projectRef, AbortSignal.timeout(5_000));
}

function changesProject(draft: DraftSessionState, projectRef: ScopedProjectRef) {
  return (
    draft.environmentId !== projectRef.environmentId || draft.projectId !== projectRef.projectId
  );
}

/**
 * Which machine an unsent draft runs on: automatic load balancing across the
 * project's machines, or a manual switch, which may first open a scratch
 * project on the target machine or clone the project there.
 */
export function useDraftEnvironmentRouting(input: DraftEnvironmentRoutingInput) {
  const {
    draftId,
    draftThread,
    envLocked,
    automaticEnvironment,
    logicalProjectEnvironments,
    machinesWithoutProject,
    activeProject,
    environmentById,
    providersByEnvironment,
    loadBalancingSettings,
    referencedThreadContexts,
    activeProviderInstanceId,
    selectedProvider,
    composerHasAttachments,
    activeProjectKey,
    activeProjectIsScratch,
    projectGroupingSettings,
    sendInFlightRef,
  } = input;
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const allProjects = useProjects();
  const readRefs = useAtomCommand(vcsEnvironment.readRefs, { reportFailure: false });
  const { openScratchProject } = useScratchProject();
  const needsLoadBalancing = automaticEnvironment && !draftThread?.loadBalancedEnvironmentId;
  const loadBalancingCandidates = automaticEnvironment
    ? logicalProjectEnvironments
        .filter((candidate) => {
          const environment = environmentById.get(candidate.environmentId);
          return (
            environment?.connection.phase === "connected" &&
            (loadBalancingSettings.loadBalancingWeights[candidate.environmentId] ?? 50) > 0 &&
            referencedThreadContexts.every(
              (record) => record.environmentId === candidate.environmentId,
            ) &&
            providersByEnvironment
              .get(candidate.environmentId)
              ?.some(
                (provider) =>
                  (activeProviderInstanceId === null ||
                    provider.instanceId === activeProviderInstanceId) &&
                  provider.driver === selectedProvider &&
                  (environment.serverConfig?.settings
                    ? resolveProjectProviderInstanceEnabled(
                        environment.serverConfig.settings,
                        candidate.projectId,
                        provider.instanceId,
                      )
                    : provider.enabled) &&
                  provider.installed &&
                  provider.status !== "error" &&
                  provider.auth.status !== "unauthenticated" &&
                  provider.availability !== "unavailable",
              )
          );
        })
        .map((candidate) => candidate.environmentId)
    : [];
  const loadBalancing = useLoadBalancedEnvironment(
    needsLoadBalancing ? loadBalancingCandidates : [],
    loadBalancingSettings.loadBalancingWeights,
  );
  const mountedRoutingScope = useRef<{ readonly key: string } | null>(null);
  const readRouting = useStableCallback(() => ({ input, loadBalancingCandidates }));
  const readWorktreeBase = (projectRef: ScopedProjectRef, branch: string | null) => {
    const cwd = readProject(projectRef)?.workspaceRoot;
    if (!cwd) return Promise.resolve(null);
    const { environmentId } = projectRef;
    return withAbortTimeout(WORKTREE_BASE_TIMEOUT_MS, async (signal) => {
      if (branch) {
        let cursor: number | undefined;
        do {
          const matching = await raceWithAbort(
            readRefs({
              environmentId,
              input: { cwd, query: branch.slice(0, 256), cursor, includeMatchingRemoteRefs: true },
            }),
            signal,
          );
          if (matching === null || matching._tag !== "Success") break;
          if (matching.value.refs.some((ref) => ref.name === branch)) return branch;
          cursor = matching.value.nextCursor ?? undefined;
        } while (cursor !== undefined && !signal.aborted);
      }
      if (signal.aborted) return null;
      const result = await raceWithAbort(
        readRefs({ environmentId, input: { cwd, limit: 2 } }),
        signal,
      );
      return result !== null && result._tag === "Success"
        ? resolveDefaultWorktreeBaseBranch(result.value.refs)
        : null;
    });
  };
  const refreshBeforeSend = () => {
    if (
      !automaticEnvironment ||
      !draftId ||
      !draftThread?.loadBalancedEnvironmentId ||
      draftThread.promotedTo ||
      composerHasAttachments
    )
      return null;
    const originalDraft = getDraftSession(draftId);
    const scope = mountedRoutingScope.current;
    if (!originalDraft || !scope) return null;
    const composerDraft = useComposerDraftStore.getState().getComposerDraft(draftId);
    const readCurrentRouting = () => {
      const current = readRouting();
      const latestDraft = getDraftSession(draftId);
      const draftMatches =
        latestDraft === originalDraft ||
        // The picker may fill an empty base while any of the routing reads are pending.
        // Its automatic write keeps the routing mode; a manual pick switches it to manual.
        (originalDraft.envMode === "worktree" &&
          originalDraft.branch === null &&
          latestDraft?.branch != null &&
          shallow(latestDraft, {
            ...originalDraft,
            branch: latestDraft.branch,
            environmentSelection: originalDraft.environmentSelection ?? "auto",
          }));
      return mountedRoutingScope.current === scope &&
        current.input.draftId === draftId &&
        current.input.automaticEnvironment &&
        !current.input.composerHasAttachments &&
        current.input.activeProjectKey === activeProjectKey &&
        current.input.selectedProvider === selectedProvider &&
        current.input.activeProviderInstanceId === activeProviderInstanceId &&
        current.input.loadBalancingSettings.loadBalancingWeights ===
          loadBalancingSettings.loadBalancingWeights &&
        current.loadBalancingCandidates.join("\n") === loadBalancingCandidates.join("\n") &&
        draftMatches &&
        useComposerDraftStore.getState().getComposerDraft(draftId) === composerDraft
        ? current
        : null;
    };
    return loadBalancing.refreshSelection(loadBalancingCandidates).then(async (environmentId) => {
      const current = readCurrentRouting();
      if (!current) return false;
      const target = current.input.logicalProjectEnvironments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!target?.projectId) {
        toastManager.add({
          type: "warning",
          ...loadBalancingSendWarning({
            pending: false,
            threadContexts: referencedThreadContexts,
            candidateEnvironmentIds: loadBalancingCandidates,
          }),
        });
        return false;
      }
      const projectRef = scopeProjectRef(target.environmentId, target.projectId);
      const moved = changesProject(originalDraft, projectRef);
      const workspace = moved ? await readDestinationWorkspace(originalDraft, projectRef) : {};
      const isWorktree = (workspace.envMode ?? originalDraft.envMode) === "worktree";
      const branch =
        isWorktree && (moved || originalDraft.branch === null)
          ? await readWorktreeBase(projectRef, originalDraft.branch)
          : moved
            ? null
            : originalDraft.branch;
      if (
        !readCurrentRouting()?.input.logicalProjectEnvironments.some(
          (candidate) =>
            candidate.environmentId === environmentId && candidate.projectId === target.projectId,
        )
      )
        return false;

      if (target.environmentId !== originalDraft.environmentId) {
        appAtomRegistry.set(
          draftFanoutSelectionsAtom(
            scopedThreadKey(scopeThreadRef(target.environmentId, originalDraft.threadId)),
          ),
          appAtomRegistry.get(
            draftFanoutSelectionsAtom(
              scopedThreadKey(scopeThreadRef(originalDraft.environmentId, originalDraft.threadId)),
            ),
          ),
        );
      }
      // The send must read the target project's composer and provider context after retargeting.
      flushSync(() =>
        setDraftThreadContext(draftId, {
          projectRef,
          environmentSelection: "auto",
          loadBalancedEnvironmentId: target.environmentId,
          ...workspace,
          branch,
        }),
      );
      return true;
    });
  };
  const environmentChangeScope = `${draftId ?? ""}:${activeProjectKey ?? ""}`;
  // The busy state belongs to the request that set it, so an older request settling late
  // (abandoned, or superseded by a newer switch) can never clear a newer one's.
  const [busyEnvironmentChange, setBusyEnvironmentChange] = useState<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const isEnvironmentChanging = busyEnvironmentChange?.scope === environmentChangeScope;

  useEffect(() => {
    if (
      !needsLoadBalancing ||
      loadBalancing.pending ||
      !draftId ||
      isEnvironmentChanging ||
      sendInFlightRef.current
    )
      return;
    const target = logicalProjectEnvironments.find(
      (environment) => environment.environmentId === loadBalancing.environmentId,
    );
    if (!target?.projectId) return;
    const draft = getDraftSession(draftId);
    if (!draft) return;
    const projectRef = scopeProjectRef(target.environmentId, target.projectId);
    setDraftThreadContext(draftId, {
      projectRef,
      environmentSelection: "auto",
      loadBalancedEnvironmentId: target.environmentId,
    });
    if (changesProject(draft, projectRef)) {
      const current = { envMode: draft.envMode, startFromOrigin: draft.startFromOrigin };
      trackPendingWorkspaceDefault(
        draftId,
        projectRef,
        current,
        readDestinationWorkspace(draft, projectRef).then((workspace) => ({
          ...current,
          ...workspace,
        })),
      );
    }
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    isEnvironmentChanging,
    draftId,
    logicalProjectEnvironments,
    sendInFlightRef,
    getDraftSession,
    setDraftThreadContext,
  ]);
  // A change in flight belongs to the draft and project it started on.
  const environmentChangeRef = useRef<{
    readonly controller: AbortController;
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const environmentChangeScopeRef = useRef("");
  useLayoutEffect(() => {
    environmentChangeScopeRef.current = environmentChangeScope;
  });
  // Leaving the scope, or unmounting, abandons a change or routing refresh still in flight.
  useLayoutEffect(() => {
    mountedRoutingScope.current = { key: environmentChangeScope };
    return () => {
      mountedRoutingScope.current = null;
      if (environmentChangeRef.current?.scope === environmentChangeScope) {
        environmentChangeRef.current.controller.abort();
        environmentChangeRef.current = null;
      }
    };
  }, [environmentChangeScope]);
  const readPendingEnvironmentChange = () => {
    const pending = environmentChangeRef.current;
    return pending !== null && pending.scope === environmentChangeScopeRef.current ? pending : null;
  };
  const onAutoEnvironment = () => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    if (composerHasAttachments) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: "Keep attachments on this machine",
        description:
          "Remove attachments before choosing automatic routing, then attach them on the selected machine.",
      });
      return;
    }
    environmentChangeRef.current?.controller.abort();
    environmentChangeRef.current = null;
    setBusyEnvironmentChange(null);
    loadBalancing.refresh(
      logicalProjectEnvironments.map((environment) => environment.environmentId),
    );
    setDraftThreadContext(draftId, {
      environmentSelection: "auto",
      sshDestination: null,
      loadBalancedEnvironmentId: null,
      branch: null,
      worktreePath: null,
    });
  };
  const onAutoEnvironmentStable = useStableCallback(onAutoEnvironment);
  const autoEnvironmentLabel = automaticEnvironment
    ? draftThread?.loadBalancedEnvironmentId
      ? "Auto balance"
      : loadBalancing.pending
        ? "Checking machines…"
        : loadBalancing.failed
          ? "Auto balance unavailable"
          : "Auto balance"
    : undefined;

  const onEnvironmentChange = (nextEnvironmentId: EnvironmentId) => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    const originalDraft = getDraftSession(draftId);
    if (!originalDraft || originalDraft.promotedTo) return;
    const target = logicalProjectEnvironments.find(
      (env) => env.environmentId === nextEnvironmentId,
    );
    const cloneTarget = target
      ? null
      : (machinesWithoutProject.find((machine) => machine.environmentId === nextEnvironmentId) ??
        null);
    if (!target && cloneTarget?.arrival.kind !== "clone") return;
    // A second pick of a machine still being cloned to would start another clone into the same folder.
    if (!target && readPendingEnvironmentChange()?.environmentId === nextEnvironmentId) return;
    environmentChangeRef.current?.controller.abort();
    const request = {
      controller: new AbortController(),
      environmentId: nextEnvironmentId,
      scope: environmentChangeScope,
    };
    environmentChangeRef.current = request;
    setBusyEnvironmentChange(null);
    const readSwitchingDraft = () => {
      const currentDraft = getDraftSession(draftId);
      if (
        environmentChangeRef.current !== request ||
        environmentChangeScopeRef.current !== request.scope ||
        sendInFlightRef.current ||
        !currentDraft ||
        currentDraft.promotedTo ||
        currentDraft.environmentId !== originalDraft.environmentId ||
        currentDraft.projectId !== originalDraft.projectId
      )
        return null;
      return currentDraft;
    };
    /** Moves the draft unless the user moved on; says whether it did. */
    const retarget = async (project: EnvironmentProject): Promise<boolean> => {
      const draft = readSwitchingDraft();
      if (!draft) return false;
      const projectRef = scopeProjectRef(project.environmentId, project.id);
      // Use the catalog-backed list: an unpaired machine can still have a cached project snapshot.
      const findDestination = (projects: ReadonlyArray<EnvironmentProject>) =>
        projects.find(
          (candidate) =>
            candidate.environmentId === projectRef.environmentId &&
            candidate.id === projectRef.projectId,
        );
      const workspaceRoot = findDestination(readProjects())?.workspaceRoot;
      const controller = new AbortController();
      const unsubscribe = subscribeProjects((projects) => {
        if (findDestination(projects)?.workspaceRoot !== workspaceRoot) controller.abort();
      });
      const workspaceRead =
        workspaceRoot === undefined
          ? Promise.resolve({})
          : retargetDraftWorkspace(
              draft,
              projectRef,
              AbortSignal.any([request.controller.signal, controller.signal]),
            );
      const defaultWorkspace = await workspaceRead.finally(unsubscribe);
      const currentDraft = readSwitchingDraft();
      if (!currentDraft) return false;
      const destination = findDestination(readProjects());
      if (!destination) {
        toastManager.add({
          type: "error",
          title: "Could not switch machine",
          description: "This project is no longer available.",
        });
        return false;
      }
      if (controller.signal.aborted || destination.workspaceRoot !== workspaceRoot) {
        return retarget(destination);
      }
      const workspace =
        currentDraft.workspaceExplicit || currentDraft.worktreePath !== null
          ? {}
          : defaultWorkspace;
      if (activeProjectIsScratch) {
        setLogicalProjectDraftThreadId(
          deriveLogicalProjectKeyFromSettings(destination, projectGroupingSettings),
          projectRef,
          draftId,
          {
            environmentSelection: "manual",
            loadBalancedEnvironmentId: null,
            sshDestination: null,
            ...workspace,
          },
        );
      } else {
        setDraftThreadContext(draftId, {
          projectRef,
          sshDestination: null,
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
          ...workspace,
        });
      }
      return true;
    };
    const finish = () => {
      if (environmentChangeRef.current === request) environmentChangeRef.current = null;
      setBusyEnvironmentChange((busy) => (busy === request ? null : busy));
    };
    if (!target) {
      if (cloneTarget?.arrival.kind !== "clone" || !activeProject) {
        finish();
        return;
      }
      const { arrival } = cloneTarget;
      setBusyEnvironmentChange(request);
      const name = activeProject.repositoryIdentity?.displayName ?? activeProject.title;
      // The clone is registered on its machine before the reply, but this client may not
      // have the project yet; the draft moves once it does, and its composer shows the clone.
      void cloneForRunOn({
        source: { environmentId: activeProject.environmentId, cwd: activeProject.workspaceRoot },
        subdirectory: "",
        target: { environmentId: nextEnvironmentId, label: cloneTarget.label },
        projectId: newProjectId(),
        title: activeProject.title,
        remoteUrl: arrival.remoteUrl,
        destinationPath: arrival.destinationPath,
        files: [],
      })
        .then(
          async ({ ref, arrived }) => {
            const project = await arrived;
            // Unless the clone's project opens in this draft, its own toast shows progress and Cancel.
            if (!project || !(await retarget(project))) unsilenceProjectCloneToasts(ref);
          },
          (cause: unknown) => {
            if (environmentChangeRef.current !== request) return;
            toastManager.add({
              type: "error",
              title: `Could not clone ${name} to ${cloneTarget.label}`,
              description: cause instanceof Error ? cause.message : "An error occurred.",
            });
          },
        )
        .finally(finish);
      return;
    }
    if (target.projectId !== null) {
      const project = allProjects.find(
        (candidate) =>
          candidate.environmentId === target.environmentId && candidate.id === target.projectId,
      );
      if (!project) {
        finish();
        return;
      }
      setBusyEnvironmentChange(request);
      void retarget(project).finally(finish);
      return;
    }
    setBusyEnvironmentChange(request);
    void openScratchProject(target.environmentId, "Could not switch machine")
      .then(async (project) => {
        if (project) await retarget(project);
      })
      .finally(finish);
  };
  const onEnvironmentChangeStable = useStableCallback(onEnvironmentChange);

  // A draft retargeted outside this hook (an SSH destination) drops any switch still in flight.
  const cancelEnvironmentChange = () => {
    environmentChangeRef.current?.controller.abort();
    environmentChangeRef.current = null;
    setBusyEnvironmentChange(null);
  };
  return {
    cancelEnvironmentChange,
    needsLoadBalancing,
    loadBalancing,
    refreshBeforeSend,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  };
}
