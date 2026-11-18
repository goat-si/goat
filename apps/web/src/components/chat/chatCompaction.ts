import { compactionBlocksSteering } from "@goat/client-runtime/state/composer-dispatch";
import { threadSteersDuringCompaction } from "@goat/client-runtime/state/thread-workflows";

type CompactionTurnRow = {
  readonly item: {
    readonly type: string;
    readonly runId: string | null;
    readonly status?: unknown;
  };
};

/**
 * The open chat's compaction: a running compaction, or a /compact request not yet settled, and
 * whether a follow-up can still steer the turn.
 */
export function chatCompactionState(input: {
  readonly turnItems: ReadonlyArray<CompactionTurnRow>;
  readonly activityRunId: string | undefined;
  readonly activeRunId: string | null | undefined;
  readonly compactRequestIsActive: boolean;
  readonly busy: boolean;
  readonly projection: Parameters<typeof threadSteersDuringCompaction>[0];
}) {
  const compactionSettled = input.turnItems.some(
    ({ item }) =>
      item.type === "compaction" &&
      item.runId === input.activityRunId &&
      (item.status === "completed" ||
        item.status === "failed" ||
        item.status === "interrupted" ||
        item.status === "cancelled"),
  );
  const compactionRunning = input.turnItems.some(
    ({ item }) =>
      item.type === "compaction" &&
      item.runId !== null &&
      item.runId === input.activeRunId &&
      item.status === "running",
  );
  const compactCommandIsActive = input.compactRequestIsActive && !compactionSettled;
  const isCompacting = input.busy && (compactionRunning || compactCommandIsActive);
  const canSteer = !compactionBlocksSteering({
    compactCommandIsActive,
    compactionRunning,
    steersDuringCompaction: threadSteersDuringCompaction(input.projection),
    run: input.projection?.runs.find((run) => run.id === input.activeRunId),
    messages: input.projection?.messages,
  });
  return { isCompacting, canSteer };
}
