import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { isAtomCommandInterrupted } from "@goat/client-runtime/state/runtime";
import { useLayoutEffect, useRef, useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";

import { commandFailureText } from "../../lib/commandFailureText";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { useSelectedThreadDetailState } from "../../state/use-thread-detail";
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
  const presses = useRef(0);
  const latestPressByThread = useRef(new Map<string, number>());
  const showing = useRef<string | null>(null);
  const key = thread ? JSON.stringify([thread.environmentId, thread.id]) : null;
  // oxlint-disable-next-line goat/react-effect-budget -- The thread screen is reused across threads; a load settling after a switch or close must not report on what is showing then.
  useLayoutEffect(() => {
    showing.current = key;
    return () => {
      showing.current = null;
    };
  }, [key]);
  if (!thread || key === null) {
    return undefined;
  }
  if (!history.hasMoreHistory && history.error === null) {
    return undefined;
  }
  const load = (throughEntryId?: string): Promise<boolean> => {
    const press = ++presses.current;
    latestPressByThread.current.set(key, press);
    setFailure(null);
    return loadEarlierHistory({
      environmentId: thread.environmentId,
      input:
        throughEntryId === undefined
          ? { threadId: thread.id }
          : { threadId: thread.id, throughEntryId },
    }).then((result) => {
      const latest = latestPressByThread.current.get(key) === press;
      if (latest) latestPressByThread.current.delete(key);
      if (result._tag === "Success")
        return result.value._tag === "loaded" || result.value._tag === "busy";
      if (isAtomCommandInterrupted(result)) return false;
      if (!latest || showing.current !== key) return false;
      const message = commandFailureText(result, "Could not load earlier activity.");
      setFailure({ key, message });
      if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(message);
      return false;
    });
  };
  return {
    hasMoreHistory: history.hasMoreHistory,
    loading: history.loading,
    error: (failure?.key === key ? failure.message : null) ?? history.error,
    onLoadEarlier: () => void load(),
    onLoadThrough: load,
  };
}
