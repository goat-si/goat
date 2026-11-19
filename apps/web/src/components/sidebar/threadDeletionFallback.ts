import type { SidebarThreadSortOrder } from "@goat/contracts/settings";
import { effectiveSnoozed } from "@goat/client-runtime/state/thread-settled";
import { isSideChatThread } from "@goat/contracts";
import { sortThreads } from "../../lib/threadSort";
import type { Thread } from "../../types";
import { topLevelThreadCandidates } from "./topLevelThreadCandidates";

/** Subagents and side chats have no sidebar row of their own. */
function isSidebarHiddenThread(thread: Pick<Thread, "lineage" | "sideChatOf">): boolean {
  return isSideChatThread(thread) || thread.lineage.relationshipToParent === "subagent";
}

export function getFallbackThreadIdAfterDelete<T extends Thread>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  now: string;
  deletedThreadIds?: ReadonlySet<T["id"]>;
  hiddenParentKeys?: ReadonlySet<string>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, now, threads, hiddenParentKeys } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      topLevelThreadCandidates(
        threads.filter(
          (thread) => thread.id !== deletedThreadId && !deletedThreadIds?.has(thread.id),
        ),
        now,
        hiddenParentKeys,
      ).filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id) &&
          thread.settledOverride !== "settled" &&
          !effectiveSnoozed(thread, { now }) &&
          !isSidebarHiddenThread(thread),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
