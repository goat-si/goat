import type { EnvironmentId, ThreadId } from "@goat/contracts";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { useSelectedThreadDetailState } from "../../state/use-thread-detail";
import type { ThreadFeedHistoryControls } from "./ThreadFeed";

type ThreadHistory = ReturnType<typeof useSelectedThreadDetailState>["history"];

/** The Load earlier control for the selected thread, or nothing when it has no earlier history. */
export function useThreadHistoryControls(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null,
  history: ThreadHistory,
): ThreadFeedHistoryControls | undefined {
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  if (!thread) {
    return undefined;
  }
  if (!history.hasMoreHistory && history.error === null) {
    return undefined;
  }
  return {
    hasMoreHistory: history.hasMoreHistory,
    loading: history.loading,
    error: history.error,
    onLoadEarlier: () => {
      void loadEarlierHistory({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
    },
    onLoadThrough: (throughEntryId: string) => {
      void loadEarlierHistory({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, throughEntryId },
      });
    },
  };
}
