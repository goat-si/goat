import { useAtomValue } from "@effect/atom-react";
import { secondTick } from "@goat/client-runtime/clock";
import { type VcsActionState, type VcsActionTarget } from "@goat/client-runtime/state/vcs";
import { Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { appAtomRegistry } from "./atom-registry";
import { useThreadSelection } from "./use-thread-selection";
import { vcsActionManager } from "./vcs";

export function useVcsActionState(target: VcsActionTarget): VcsActionState {
  return useAtomValue(vcsActionManager.stateAtom(target));
}

export interface GitActionResultNotification {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description?: string;
  readonly prUrl?: string;
}

/** The thread a Git action ran for, which alone shows its result. */
export interface GitActionThread {
  readonly environmentId: string;
  readonly threadId: string;
}

const RESULT_DISMISS_MS = 5_000;

type ShownResult = {
  readonly result: GitActionResultNotification;
  readonly thread: GitActionThread;
};

const gitActionResultAtom = Atom.make<ShownResult | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:git-action-result"),
);
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function broadcast(shown: ShownResult | null): void {
  appAtomRegistry.set(gitActionResultAtom, shown);
}

const sameThread = (a: GitActionThread, b: GitActionThread) =>
  a.environmentId === b.environmentId && a.threadId === b.threadId;

export function showGitActionResult(
  result: GitActionResultNotification,
  thread: GitActionThread,
): void {
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = null;
  broadcast({ result, thread });
  // A failure stays until dismissed: the person may be in a Git sheet that covers the banner.
  if (result.type === "error") return;
  dismissTimer = setTimeout(() => {
    dismissTimer = null;
    broadcast(null);
  }, RESULT_DISMISS_MS);
}

/** Clears the shown result. Takes no argument: banners pass it as an event handler. */
export function dismissGitActionResult(): void {
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = null;
  broadcast(null);
}

/** Clears the shown result only when it is this thread's. */
export function dismissThreadGitActionResult(thread: GitActionThread): void {
  const shown = appAtomRegistry.get(gitActionResultAtom);
  if (shown !== null && sameThread(shown.thread, thread)) dismissGitActionResult();
}

/** The latest Git action result when it belongs to this thread; another thread's stays for that thread. */
export function useGitActionResultNotification(thread: GitActionThread | null): {
  readonly result: GitActionResultNotification | null;
  readonly dismiss: () => void;
} {
  const shown = useAtomValue(gitActionResultAtom);
  const result =
    shown !== null && thread !== null && sameThread(shown.thread, thread) ? shown.result : null;
  return { result, dismiss: () => dismissGitActionResult() };
}

export type GitActionProgressPhase = "idle" | "running" | "success" | "error";

export interface GitActionProgress {
  readonly phase: GitActionProgressPhase;
  readonly label: string | null;
  readonly description: string | null;
  readonly prUrl?: string;
}

const subscribeNever = () => () => {};

const EMPTY_PROGRESS: GitActionProgress = {
  phase: "idle",
  label: null,
  description: null,
};

function formatElapsedSeconds(ms: number | null, nowMs: number): string | null {
  if (ms === null) return null;
  const elapsed = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (elapsed < 2) return null;
  return `Running for ${elapsed}s`;
}

/** Progress of the selected thread's Git action in this checkout. */
export function useGitActionProgress(target: VcsActionTarget): GitActionProgress {
  const actionState = useVcsActionState(target);
  const { selectedThread } = useThreadSelection();
  const { result } = useGitActionResultNotification(
    selectedThread === null
      ? null
      : { environmentId: selectedThread.environmentId, threadId: selectedThread.id },
  );

  // Only a running action shows elapsed time, so only it subscribes to the second tick.
  const nowMs = useSyncExternalStore(
    actionState.isRunning ? secondTick.subscribe : subscribeNever,
    secondTick.getSnapshot,
  );

  if (actionState.isRunning) {
    const description =
      actionState.lastOutputLine ??
      formatElapsedSeconds(actionState.hookStartedAtMs ?? actionState.phaseStartedAtMs, nowMs);
    return {
      phase: "running",
      label: actionState.currentLabel,
      description,
    };
  }

  if (result) {
    return {
      phase: result.type,
      label: result.title,
      description: result.description ?? null,
      prUrl: result.prUrl,
    };
  }

  return EMPTY_PROGRESS;
}
