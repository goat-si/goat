import type { SidebarThreadSortOrder } from "@goat/contracts/settings";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@goat/client-runtime/state/thread-settled";
import { sortThreads, type ThreadSortInput } from "../../lib/threadSort";
import type { Thread } from "../../types";

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt" | "settledOverride"> &
    ThreadSortInput &
    ThreadSnoozeShell,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  now: string;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, now, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id) &&
          thread.settledOverride !== "settled" &&
          !effectiveSnoozed(thread, { now }),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
