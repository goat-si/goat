import type { OrchestrationV2ThreadProjection } from "@goat/contracts";
import * as Option from "effect/Option";

import type { ThreadHistoryMeta } from "./threadHistoryMerge.ts";
import type { EnvironmentThreadState } from "./threadState.ts";

export function formatHistoryError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Could not load earlier activity.";
}

export interface ThreadResumeSnapshot {
  readonly state: EnvironmentThreadState;
  readonly sequence: number;
  readonly persisted: boolean;
  readonly acceptsBoundedSnapshots?: boolean;
}

export interface ThreadResumeCache {
  snapshot: ThreadResumeSnapshot | undefined;
  owner: object | undefined;
}

export function matchesThreadSnapshot(
  current: ThreadResumeSnapshot,
  projection: OrchestrationV2ThreadProjection | null,
  sequence: number,
  history: Pick<ThreadHistoryMeta, "historyCursor" | "hasMoreHistory" | "latestLocalTurnOrdinal">,
): boolean {
  if (current.sequence !== sequence || Option.getOrNull(current.state.data) !== projection)
    return false;
  const currentHistory = current.state.history;
  return (
    currentHistory.historyCursor === history.historyCursor &&
    currentHistory.hasMoreHistory === history.hasMoreHistory &&
    (!(history.hasMoreHistory || history.historyCursor !== null) ||
      currentHistory.latestLocalTurnOrdinal === history.latestLocalTurnOrdinal)
  );
}
