import {
  shouldShowLoadEarlierControl,
  type ThreadHistoryMeta,
} from "@goat/client-runtime/state/threads";
import type { ScopedThreadRef } from "@goat/contracts";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";

/** The timeline's "Load earlier" control for a thread, or undefined when there is nothing to load. */
export function useThreadHistoryControls(
  threadRef: ScopedThreadRef | null,
  history: ThreadHistoryMeta,
): MessagesTimelineHistoryControls | undefined {
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  if (threadRef === null || !shouldShowLoadEarlierControl(history)) return undefined;
  return {
    hasMoreHistory: history.hasMoreHistory,
    loading: history.loading,
    error: history.error,
    onLoadEarlier: (throughEntryId) => {
      void loadEarlier({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          ...(throughEntryId === undefined ? {} : { throughEntryId }),
        },
      });
    },
  };
}
