import type { ScopedThreadRef } from "@goat/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { AppState } from "react-native";

import { useQuietThreadShell } from "../../state/entities";

const ATTENTION_REFRESH_MS = 30_000;

/**
 * Keeps a thread's workspace status current, by the rules of web's useThreadWorkspaceStatus: on
 * each run; and while the worktree needs attention, on returning to the app, every half minute,
 * and on new thread items (a terminal that restored the folder starts no run but leaves a notice).
 */
export function useThreadWorkspaceStatusRefresh(
  threadRef: ScopedThreadRef,
  needsAttention: boolean,
  refresh: () => void,
) {
  const shell = useQuietThreadShell(threadRef);
  const latestRunId = shell?.latestRun?.runId ?? null;
  const itemCount = needsAttention ? (shell?.itemCount ?? null) : null;
  const onRefresh = useEffectEvent(refresh);
  const seenRunId = useRef(latestRunId);
  const seenItemCount = useRef(itemCount);

  // oxlint-disable-next-line goat/react-effect-budget -- a new run on the server re-reads its status
  useEffect(() => {
    if (seenRunId.current === latestRunId) return;
    seenRunId.current = latestRunId;
    onRefresh();
  }, [latestRunId]);

  // oxlint-disable-next-line goat/react-effect-budget -- new thread items re-read a status that needs attention
  useEffect(() => {
    const seen = seenItemCount.current;
    seenItemCount.current = itemCount;
    if (seen === null || itemCount === null || seen === itemCount) return;
    onRefresh();
  }, [itemCount]);

  // oxlint-disable-next-line goat/react-effect-budget -- follows the app's foreground state and a timer while attention is needed
  useEffect(() => {
    if (!needsAttention) return;
    let appState = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next) => {
      const returned = appState !== "active" && next === "active";
      appState = next;
      if (returned) onRefresh();
    });
    const timer = setInterval(() => {
      if (appState === "active") onRefresh();
    }, ATTENTION_REFRESH_MS);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [needsAttention]);
}
