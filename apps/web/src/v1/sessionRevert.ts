import type { ThreadCheckpointSummary } from "@goat/client-runtime/state/thread-checkpoints";
import type { OrchestrationV2Checkpoint, RunId } from "@goat/contracts";

import type { TimelineEntry } from "./session-logic";
import type { ChatMessage } from "./types";

// Run ordinals keep increasing after a rewind; only visible local runs define predecessors.
export function deriveRevertTurnCountByUserMessageId(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly checkpoints: ReadonlyArray<ThreadCheckpointSummary>;
  readonly threadStartCheckpointAvailable: boolean;
  readonly availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  readonly unsettledRunId?: RunId | null;
}): Map<ChatMessage["id"], number> {
  const turnCountByRunId = new Map<RunId, number>();
  for (const checkpoint of input.checkpoints) {
    if (isRewindableCheckpoint(checkpoint)) {
      turnCountByRunId.set(checkpoint.runId, checkpoint.checkpointTurnCount);
    }
  }
  const targetByRunId = new Map<RunId, number | undefined>();
  const byUserMessageId = new Map<ChatMessage["id"], number>();
  let previousRunId: RunId | null = null;
  for (const entry of input.timelineEntries) {
    // Inherited history belongs to the source thread, not our checkpoint scope.
    if (entry.kind !== "message" && entry.kind !== "work") continue;
    const projectedItem =
      entry.kind === "message" ? entry.projectedItem : entry.entry.projectedItem;
    if (projectedItem?.visibility === "inherited") continue;
    const runId =
      entry.kind === "message"
        ? entry.message.runId
        : entry.entry.itemType === "notification"
          ? entry.entry.runId
          : null;
    if (runId == null) continue;
    if (!targetByRunId.has(runId)) {
      targetByRunId.set(
        runId,
        previousRunId === null
          ? input.threadStartCheckpointAvailable
            ? 0
            : undefined
          : turnCountByRunId.get(previousRunId),
      );
      previousRunId = runId;
    }
    if (entry.kind !== "message") continue;
    const { message } = entry;
    if (message.role !== "user" || message.runId === input.unsettledRunId) continue;
    if (message.inputIntent !== "turn_start" && message.inputIntent !== "queued_turn") continue;
    const target = targetByRunId.get(runId);
    if (
      target !== undefined &&
      (input.availableRevertTurnCounts === undefined || input.availableRevertTurnCounts.has(target))
    )
      byUserMessageId.set(message.id, target);
  }
  return byUserMessageId;
}

// Missing and failed snapshots still pin a conversation position; restoring files needs a ready one.
function isRewindableCheckpoint(checkpoint: Pick<OrchestrationV2Checkpoint, "status">) {
  return checkpoint.status !== "stale";
}

export function findRevertCheckpoint(
  checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>,
  turnCount: number,
): OrchestrationV2Checkpoint | undefined {
  return checkpoints.findLast(
    (checkpoint) =>
      isRewindableCheckpoint(checkpoint) &&
      (turnCount === 0
        ? checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null
        : checkpoint.appRunOrdinal === turnCount),
  );
}
