import { isSideChatThread } from "@goat/contracts";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import type { ScopedThreadRef } from "@goat/contracts";
import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { useRightPanelStore } from "../../rightPanelStore";
import { useSideChatStore } from "./sideChatStore";

export { parseSideChatCommand } from "@goat/client-runtime/state/unsent-question-answers";

/**
 * The side chat a thread shows: its newest live one. Clearing a side chat deletes it, so
 * older live ones only exist when another client started one at the same time.
 */
export function findSideChatThread(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  parent: ScopedThreadRef,
  selected?: ScopedThreadRef["threadId"] | null,
): EnvironmentThreadShell | null {
  let latest: EnvironmentThreadShell | null = null;
  for (const shell of shells) {
    if (
      shell.environmentId !== parent.environmentId ||
      shell.sideChatOf !== parent.threadId ||
      shell.archivedAt !== null ||
      shell.deletedAt !== null
    )
      continue;
    if (shell.id === selected) return shell;
    if (latest === null || shell.createdAt > latest.createdAt) latest = shell;
  }
  return latest;
}

export function resolveSideChatOpen(
  ref: ScopedThreadRef,
  thread: { readonly sideChatOf?: ScopedThreadRef["threadId"] | null | undefined } | null,
): ScopedThreadRef {
  if (!thread?.sideChatOf) return ref;
  const parent = scopeThreadRef(ref.environmentId, thread.sideChatOf);
  useSideChatStore.getState().selectSideChat(scopedThreadKey(parent), ref.threadId);
  useRightPanelStore.getState().open(parent, "side-chat");
  return parent;
}

export function canOpenSideChat(
  thread: { readonly sideChatOf?: ScopedThreadRef["threadId"] | null | undefined } | null,
): boolean {
  return thread !== null && !isSideChatThread(thread);
}

export type SideChatParentTone = "active" | "attention" | "idle" | "error";

/** What the side chat's header says the main thread is doing right now. */
export function sideChatParentStatus(
  parent: Pick<
    EnvironmentThreadShell,
    "runtime" | "latestRun" | "hasPendingApprovals" | "hasPendingUserInput" | "goal"
  >,
): { readonly label: string; readonly tone: SideChatParentTone } {
  if (parent.hasPendingApprovals) return { label: "Needs approval", tone: "attention" };
  if (parent.hasPendingUserInput) return { label: "Needs input", tone: "attention" };
  switch (parent.runtime?.status) {
    case "preparing":
    case "queued":
    case "starting":
      return { label: "Starting", tone: "active" };
    case "running":
    case "waiting":
      return { label: "Working", tone: "active" };
  }
  if (parent.goal?.status === "paused") return { label: "Goal paused", tone: "attention" };
  switch (parent.latestRun?.status) {
    case "interrupted":
      return { label: "Interrupted", tone: "idle" };
    case "failed":
      return { label: "Failed", tone: "error" };
    default:
      return { label: "Idle", tone: "idle" };
  }
}
