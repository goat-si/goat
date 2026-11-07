import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@goat/contracts";
import type * as ProjectionStore from "./ProjectionStore.ts";

export function nonterminalRuns(projection: ProjectionStore.ProjectionRuntimeRecoveryState) {
  return projection.runs.filter((run) => {
    const status: string = run.status;
    return (
      status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting"
    );
  });
}

export function isNonterminalTurnItemStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

export function isNonterminalNodeStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

export function isAppOwnedDelegation(task: {
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly childThreadId: ThreadId | null;
  readonly remote?: OrchestrationV2Subagent["remote"];
}): boolean {
  return task.origin === "app_owned" && (task.childThreadId !== null || task.remote !== undefined);
}

export function isAppOwnedDelegationItem(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  delegatedTaskNodeIds: ReadonlySet<string>,
): boolean {
  return (
    item.type === "subagent" &&
    (isAppOwnedDelegation(item) || delegatedTaskNodeIds.has(item.subagentId))
  );
}
