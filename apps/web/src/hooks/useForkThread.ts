import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentProject, EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import {
  threadForkAvailability,
  type ThreadForkAvailability,
} from "@goat/client-runtime/state/thread-workflows";
import {
  CommandId,
  OrchestrationV2ThreadForkError,
  type OrchestrationV2ThreadForkWorkspace,
  type OrchestrationV2ThreadForkWorktreeResult,
  type RunId,
  type ScopedThreadRef,
} from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ThreadActionMenuId, ThreadForkMenuState } from "../components/threadActionMenu.logic";
import { toastManager } from "../components/ui/toast";
import { isGlobalAgentThread } from "../globalAgentRoute";
import { useGlobalAgentStore } from "../globalAgentStore";
import { newThreadId, randomUUID } from "../lib/utils";
import { readLocalApi } from "../localApi";
import {
  readEnvironmentSupportsForkWorkspace,
  readProject,
  readThreadShell,
  useEnvironmentSupportsForkWorkspace,
  useProject,
  useThreadShell,
  waitForThreadShell,
} from "../state/entities";
import { readEnvironmentProxiedByHub, usePreparedConnection } from "../state/session";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";

/** What only the open chat knows; menus leave both unknown and let the server refuse. */
export interface KnownForkState {
  readonly isGitRepository?: boolean;
  readonly cloud?: boolean;
}

interface ForkAvailabilityInput {
  readonly shell: EnvironmentThreadShell | null;
  readonly project: EnvironmentProject | null;
  readonly serverForks: boolean;
  readonly viaHubProxy: boolean;
  readonly known?: KnownForkState | undefined;
}

/** Null hides every fork entry: no thread yet, or a side chat. */
function forkAvailabilityFor(input: ForkAvailabilityInput): ThreadForkAvailability | null {
  const { shell } = input;
  if (shell === null || shell.sideChatOf != null) return null;
  return threadForkAvailability({
    thread: { latestRunId: shell.latestRun?.runId ?? null, worktreePath: shell.worktreePath },
    capabilities: { threadForkWorkspace: input.serverForks },
    // An unknown repository still offers the worktree choice; the server refuses a folder without Git.
    project: {
      isGitRepository: input.known?.isGitRepository ?? true,
      isScratch: input.project?.isScratch === true,
    },
    cloud: input.known?.cloud ?? false,
    viaHubProxy: input.viaHubProxy,
  });
}

function readForkAvailabilityInput(threadRef: ScopedThreadRef): ForkAvailabilityInput {
  const shell = readThreadShell(threadRef);
  return {
    shell,
    project: shell ? readProject(scopeProjectRef(threadRef.environmentId, shell.projectId)) : null,
    serverForks: readEnvironmentSupportsForkWorkspace(threadRef.environmentId),
    viaHubProxy: readEnvironmentProxiedByHub(threadRef.environmentId),
  };
}

export function readThreadForkAvailability(
  threadRef: ScopedThreadRef,
  known?: KnownForkState,
): ThreadForkAvailability | null {
  return forkAvailabilityFor({ ...readForkAvailabilityInput(threadRef), known });
}

export function readThreadForkMenuState(threadRef: ScopedThreadRef): ThreadForkMenuState | null {
  const input = readForkAvailabilityInput(threadRef);
  const availability = forkAvailabilityFor(input);
  if (availability === null) return null;
  return {
    canFork: availability.canFork,
    canForkIntoWorktree: availability.canForkIntoWorktree,
    inWorktree: availability.inWorktree,
    needsServerUpdate: input.viaHubProxy && !input.serverForks,
  };
}

export function useThreadForkAvailability(
  threadRef: ScopedThreadRef | null,
  known?: KnownForkState,
): ThreadForkAvailability | null {
  const shell = useThreadShell(threadRef);
  const project = useProject(
    shell === null ? null : scopeProjectRef(shell.environmentId, shell.projectId),
  );
  const serverForks = useEnvironmentSupportsForkWorkspace(threadRef?.environmentId ?? null);
  const prepared = usePreparedConnection(threadRef?.environmentId ?? null);
  const globalAgentRef = useGlobalAgentStore((state) => state.ref);
  const viaHubProxy =
    Option.isSome(prepared) && prepared.value.target._tag === "HubProxyConnectionTarget";
  // The global agent is one agent, not a thread to copy; its menus hide forking too.
  if (shell !== null && isGlobalAgentThread(shell, globalAgentRef)) return null;
  return forkAvailabilityFor({ shell, project, serverForks, viaHubProxy, known });
}

export function forkMenuWorkspace(
  action: Extract<ThreadActionMenuId, "fork:current" | "fork:worktree">,
): OrchestrationV2ThreadForkWorkspace {
  return { type: action === "fork:worktree" ? "worktree" : "current" };
}

export interface ForkThreadOptions {
  /** Fork from this response's run instead of the latest finished turn. */
  readonly runId?: RunId;
  /** The fork is named "<title> fork"; defaults to the source thread's title. */
  readonly title?: string;
}

function worktreeOutcome(worktree: OrchestrationV2ThreadForkWorktreeResult) {
  const notes = [`Branch ${worktree.branch}.`];
  if (worktree.uncommitted === "left") {
    notes.push("Uncommitted changes stayed in the original checkout.");
  }
  if (worktree.setupScript === "failed") notes.push("The project setup script did not start.");
  return {
    type: worktree.setupScript === "failed" ? ("warning" as const) : ("success" as const),
    title: "Forked into a new worktree",
    description: notes.join(" "),
    timeout: 6000,
  };
}

// A second request while one is pending would make a second fork; the desktop app drops it too.
const forksInFlight = new Set<string>();
const isForkRefusal = Schema.is(OrchestrationV2ThreadForkError);

/** Forks a thread into its own checkout or a new worktree, then opens the fork. */
export function useForkThread() {
  const fork = useOrchestrationCommand(threadEnvironment.fork, { reportFailure: false });
  const navigate = useNavigate();
  const forkThread = async (
    threadRef: ScopedThreadRef,
    workspace: OrchestrationV2ThreadForkWorkspace,
    options?: ForkThreadOptions,
  ): Promise<void> => {
    const key = scopedThreadKey(threadRef);
    if (forksInFlight.has(key)) return;
    forksInFlight.add(key);
    const toastId = toastManager.add({ type: "loading", title: "Forking thread…", timeout: 0 });
    const title = options?.title ?? readThreadShell(threadRef)?.title;
    const targetThreadRef = scopeThreadRef(threadRef.environmentId, newThreadId());
    const result = await fork({
      environmentId: threadRef.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        creationSource: "web",
        sourceThreadId: threadRef.threadId,
        targetThreadId: targetThreadRef.threadId,
        sourcePoint:
          options?.runId === undefined
            ? { type: "latest_stable" }
            : { type: "run", runId: options.runId },
        ...(title ? { title: `${title} fork` } : {}),
        workspace,
        serverForks: readEnvironmentSupportsForkWorkspace(threadRef.environmentId),
      },
    }).finally(() => forksInFlight.delete(key));
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        toastManager.close(toastId);
        return;
      }
      const error = squashAtomCommandFailure(result);
      const refusal = isForkRefusal(error) ? error : null;
      const kept = refusal?.retainedWorktreePath;
      const withoutChanges =
        refusal?.reason === "uncommitted_unsupported" && workspace.type === "worktree";
      toastManager.update(toastId, {
        type: "error",
        title: "Could not fork thread",
        description: [
          error instanceof Error ? error.message : "The server refused the fork.",
          ...(kept ? [`The new checkout was kept at ${kept}.`] : []),
        ].join(" "),
        timeout: 15_000,
        ...(withoutChanges
          ? {
              actionProps: {
                children: "Fork without uncommitted changes",
                onClick: () => {
                  toastManager.close(toastId);
                  void forkThread(threadRef, { ...workspace, includeUncommitted: false }, options);
                },
              },
            }
          : {}),
      });
      return;
    }
    const worktree = result.value.worktree;
    if (worktree) toastManager.update(toastId, worktreeOutcome(worktree));
    else toastManager.close(toastId);
    if (!(await waitForThreadShell(targetThreadRef))) {
      toastManager.add({
        type: "error",
        title: "Fork created",
        description:
          "Its thread data did not reach this client. Reconnect and open it from the sidebar.",
      });
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
  };
  return forkThread;
}

export interface ForkChoiceLabels {
  readonly current: string;
  readonly sameWorktree: string;
  readonly worktree: string;
}

const THREAD_FORK_LABELS: ForkChoiceLabels = {
  current: "Fork thread",
  sameWorktree: "Fork thread in same worktree",
  worktree: "Fork thread in new worktree",
};

/** A response's fork button, worded like the desktop app's "Fork chat from here". */
export const RESPONSE_FORK_LABELS: ForkChoiceLabels = {
  current: "Fork in this workspace",
  sameWorktree: "Fork in this worktree",
  worktree: "Fork in a new worktree",
};

// The composer's editor keeps focus when a command is picked or submitted.
function focusedFormAnchor(): { x: number; y: number } {
  const focused = document.activeElement;
  const target =
    focused instanceof Element && focused !== document.body
      ? (focused.closest("form") ?? focused)
      : document.querySelector('[data-chat-composer-form="true"]');
  if (target === null) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const box = target.getBoundingClientRect();
  return { x: box.left, y: box.top };
}

/** Asks where to fork when a new worktree is possible; otherwise forks in the current checkout. */
export function useForkWithChoice() {
  const forkThread = useForkThread();
  return async (
    threadRef: ScopedThreadRef,
    availability: ThreadForkAvailability,
    options?: ForkThreadOptions & {
      readonly anchor?: { readonly x: number; readonly y: number };
      readonly labels?: ForkChoiceLabels;
    },
  ): Promise<void> => {
    if (!availability.canForkIntoWorktree)
      return forkThread(threadRef, { type: "current" }, options);
    const api = readLocalApi();
    if (!api) return;
    const labels = options?.labels ?? THREAD_FORK_LABELS;
    const items = [
      {
        id: "current" as const,
        label: availability.inWorktree ? labels.sameWorktree : labels.current,
        icon: "git-fork",
      },
      { id: "worktree" as const, label: labels.worktree, icon: "git-branch" },
    ];
    const picked = await settlePromise(() =>
      api.contextMenu.show(items, options?.anchor ?? focusedFormAnchor()),
    );
    if (picked._tag === "Failure" || picked.value === null) return;
    return forkThread(threadRef, { type: picked.value }, options);
  };
}

export interface ComposerForkCommand {
  readonly description: string;
  readonly run: () => void;
}

/**
 * The composer's /fork, or undefined where this connection or thread cannot fork. A typed /fork
 * runs it before any other send branch, so it never reaches the provider.
 */
export function useComposerForkCommand(input: {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly isServerThread: boolean;
  readonly isGitRepo: boolean;
  readonly isCloudThread: boolean;
}): ComposerForkCommand | undefined {
  const threadRef = input.isServerThread ? input.activeThreadRef : null;
  const availability = useThreadForkAvailability(threadRef, {
    isGitRepository: input.isGitRepo,
    cloud: input.isCloudThread,
  });
  const permitted = useAtomValue(
    threadEnvironment.fork.permissionAtom(threadRef?.environmentId ?? null),
  );
  const forkWithChoice = useForkWithChoice();
  if (threadRef === null || availability === null || !availability.canFork || !permitted) {
    return undefined;
  }
  return {
    description: !availability.canForkIntoWorktree
      ? "Fork this thread"
      : availability.inWorktree
        ? "Fork this thread in the same worktree or a new worktree"
        : "Fork this thread in the current workspace or a new worktree",
    run: () => void forkWithChoice(threadRef, availability),
  };
}
