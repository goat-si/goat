import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@goat/contracts";

/** Where a declined steer's follow-up queues: right after the run it steered and earlier steers. */
export function steerFollowUpQueuePosition(
  command: {
    readonly messageId: string;
    readonly steerFollowUpOfRunId?: string | undefined;
    readonly steerFollowUpAfterRunOrdinal?: number | undefined;
  },
  projection: {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  },
): number | undefined {
  const afterRunOrdinal = command.steerFollowUpAfterRunOrdinal;
  if (command.steerFollowUpOfRunId === undefined || afterRunOrdinal === undefined) return undefined;
  const steerOrdinal =
    projection.turnItems.find(
      (item) => item.type === "user_message" && item.messageId === command.messageId,
    )?.ordinal ?? -1;
  // Earlier declined steers have newer runs but retain their original turn-item ordinals.
  const earlierSteerMessageIds = new Set(
    projection.turnItems.flatMap((item) =>
      item.type === "user_message" && item.ordinal < steerOrdinal ? [item.messageId] : [],
    ),
  );
  return (
    Math.max(
      0,
      ...projection.runs
        .filter(
          (candidate) =>
            candidate.status === "queued" &&
            (candidate.ordinal <= afterRunOrdinal ||
              earlierSteerMessageIds.has(candidate.userMessageId)),
        )
        .map((candidate) => candidate.queuePosition ?? candidate.ordinal),
    ) + 1
  );
}

/** The queued runs at or after the follow-up's position, each moved one place back. */
export function runsBehindSteerFollowUp(
  runs: ReadonlyArray<OrchestrationV2Run>,
  position: number | undefined,
): ReadonlyArray<OrchestrationV2Run> {
  if (position === undefined) return [];
  return runs.flatMap((queued) =>
    queued.status !== "queued" || (queued.queuePosition ?? queued.ordinal) < position
      ? []
      : [{ ...queued, queuePosition: (queued.queuePosition ?? queued.ordinal) + 1 }],
  );
}
