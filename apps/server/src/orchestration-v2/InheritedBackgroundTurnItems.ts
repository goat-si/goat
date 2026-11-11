import type {
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import {
  isSettledRunEligibleForInheritedBackground,
  isSettledTurnItemStatus,
} from "./providerTurnStatus.ts";

type InheritedBackgroundTurnItemRoute = {
  readonly id: TurnItemId;
  readonly runId: OrchestrationV2Run["id"];
};

export const backgroundCapableTurnItemTypes: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set(
  ["command_execution", "dynamic_tool", "subagent"],
);

/** Use durable provider-thread lineage; sessions can host multiple threads. */
export function selectInheritedBackgroundTurnItems(input: {
  readonly threadId: ThreadId;
  readonly currentProviderThreadId: ProviderThreadId;
  readonly currentRunOrdinal: number;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): ReadonlyArray<InheritedBackgroundTurnItemRoute> {
  const settledPriorRunIds = new Set(
    input.runs
      .filter(
        (run) =>
          run.threadId === input.threadId &&
          run.ordinal < input.currentRunOrdinal &&
          isSettledRunEligibleForInheritedBackground(run.status),
      )
      .map((run) => run.id),
  );
  return input.turnItems.flatMap((turnItem) =>
    turnItem.threadId === input.threadId &&
    turnItem.providerThreadId === input.currentProviderThreadId &&
    turnItem.runId !== null &&
    settledPriorRunIds.has(turnItem.runId) &&
    backgroundCapableTurnItemTypes.has(turnItem.type) &&
    !isSettledTurnItemStatus(turnItem.status)
      ? [{ id: turnItem.id, runId: turnItem.runId }]
      : [],
  );
}
