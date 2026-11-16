import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import {
  shouldShowLoadEarlierControl,
  type ThreadHistoryMeta,
} from "@goat/client-runtime/state/threads";
import type { ScopedThreadRef } from "@goat/contracts";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
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
      }).then((result) => {
        // A load that ran reports its own failure in the history state; this covers one that never ran.
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not load earlier messages",
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}
