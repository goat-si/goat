import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { isAtomCommandInterrupted } from "@goat/client-runtime/state/runtime";
import { useRef, useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { useSelectedThreadDetailState } from "../../state/use-thread-detail";
import { commandFailureText } from "../../lib/commandFailureText";
import type { ThreadFeedHistoryControls } from "./ThreadFeed";

type ThreadHistory = ReturnType<typeof useSelectedThreadDetailState>["history"];

/**
 * The Load earlier control for the selected thread, or nothing when it has no earlier history.
 * A load the command refuses never reaches the history, so its failure is kept here.
 */
export function useThreadHistoryControls(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null,
  history: ThreadHistory,
): ThreadFeedHistoryControls | undefined {
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const latestPress = useRef(0);
  if (!thread) {
    return undefined;
  }
  if (!history.hasMoreHistory && history.error === null) {
    return undefined;
  }
  const key = JSON.stringify([thread.environmentId, thread.id]);
  const load = (throughEntryId?: string) => {
    const press = ++latestPress.current;
    setFailure(null);
    void loadEarlierHistory({
      environmentId: thread.environmentId,
      input:
        throughEntryId === undefined
          ? { threadId: thread.id }
          : { threadId: thread.id, throughEntryId },
    }).then((result) => {
      if (press !== latestPress.current || result._tag !== "Failure") return;
      if (isAtomCommandInterrupted(result)) return;
      const message = commandFailureText(result, "Could not load earlier activity.");
      setFailure({ key, message });
      if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(message);
    });
  };
  return {
    hasMoreHistory: history.hasMoreHistory,
    loading: history.loading,
    error: (failure?.key === key ? failure.message : null) ?? history.error,
    onLoadEarlier: () => load(),
    onLoadThrough: (throughEntryId: string) => load(throughEntryId),
  };
}
