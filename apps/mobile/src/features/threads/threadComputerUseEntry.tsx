import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import {
  computerUseRunStatus,
  type ComputerUseRun,
} from "@goat/client-runtime/work-log/computer-use";
import type { WorkLogToolLifecycleStatus } from "@goat/client-runtime/work-log/presentation";
import { ThreadComputerUseHistoryForItem } from "./ThreadComputerUseHistory";
import { ThreadComputerUseCard } from "./ThreadComputerUseCard";

export function threadHistoryForItem(
  environmentId: EnvironmentId,
  row: OrchestrationV2ProjectedTurnItem,
) {
  return (
    <ThreadComputerUseHistoryForItem
      key={JSON.stringify([environmentId, row.sourceThreadId])}
      environmentId={environmentId}
      threadId={row.sourceThreadId}
      item={row.item}
    />
  );
}

export function threadComputerUseEntry(
  environmentId: EnvironmentId,
  row: OrchestrationV2ProjectedTurnItem,
  run: ComputerUseRun | undefined,
  status: WorkLogToolLifecycleStatus | undefined,
  expanded: boolean,
) {
  if (!expanded) return null;
  return run ? (
    <ThreadComputerUseCard
      run={run}
      status={computerUseRunStatus(status)}
      row={row}
      environmentId={environmentId}
    />
  ) : (
    threadHistoryForItem(environmentId, row)
  );
}
