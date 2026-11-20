import { isCompactionCommandMessage } from "@goat/contracts";
import { LIVE_ACTIVITY_ROW_ID, type ThreadFeedEntry } from "../../lib/threadActivity";
import type { PendingThreadFeedEntry } from "./pending-thread-feed";

export interface PendingFoldFeedEntry {
  readonly type: "pending-fold";
  readonly id: string;
  readonly createdAt: string;
  readonly messageId: string;
}

export function createPendingTurnAppender() {
  let fold: PendingFoldFeedEntry | null = null;
  let activity: Extract<ThreadFeedEntry, { readonly type: "thinking" }> | null = null;
  return (feed: ReadonlyArray<PendingThreadFeedEntry>, options: { readonly zen: boolean }) => {
    const last = feed.at(-1);
    if (
      last?.type !== "message" ||
      last.message.role !== "user" ||
      last.pendingMessage === undefined ||
      last.pendingMessage.creation !== undefined ||
      isCompactionCommandMessage(last.message) ||
      feed.some(
        (entry) =>
          entry.type === "thinking" ||
          (entry.type === "run-fold" &&
            "workingSince" in entry &&
            entry.workingSince !== undefined),
      )
    )
      return feed;
    const label = last.acknowledged ? "Starting…" : "Sending…";
    if (activity?.createdAt !== last.createdAt || activity.label !== label) {
      activity = {
        type: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: last.createdAt,
        runId: null,
        label,
      };
    }
    if (options.zen) return [...feed, activity];
    if (fold?.messageId !== last.id) {
      fold = {
        type: "pending-fold",
        id: `pending-fold:${last.id}`,
        createdAt: last.createdAt,
        messageId: last.id,
      };
    }
    return [...feed, fold, activity];
  };
}
