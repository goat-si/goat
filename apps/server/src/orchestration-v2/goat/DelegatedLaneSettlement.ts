import * as Effect from "effect/Effect";

import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";

type Lane = Pick<
  ProjectionStore.ProjectionSettlementCandidate,
  "id" | "status" | "latestRunId" | "latestRunCompletedAt" | "lineage" | "forkedFrom"
>;

/**
 * A task.create child whose latest run completed and whose result for that run reached its parent
 * is done; settling it releases what it still holds. Failed or interrupted children stay open for
 * the parent to retry, and a new message unsettles a settled one.
 */
export const makeDelegatedLaneSettlement = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return Effect.fn("DelegatedLaneSettlement.settledAt")(function* (lane: Lane) {
    const parentId = lane.lineage.parentThreadId;
    if (
      lane.lineage.relationshipToParent !== "subagent" ||
      parentId === null ||
      lane.forkedFrom?.type !== "node" ||
      lane.status !== "completed" ||
      lane.latestRunId === null ||
      lane.latestRunCompletedAt === null
    )
      return null;
    if (yield* orchestrator.delegatedTaskResultPending(lane.id)) return null;
    const child = yield* projections.getThreadRecords(lane.id, ["runs"]);
    // Settling cancels queued automatic runs, so a child with anything queued is not done.
    if (child.runs.some((run) => run.status === "queued")) return null;
    const parent = yield* projections.getThreadRecords(parentId, ["subagents", "contextTransfers"]);
    const appOwned = parent.subagents.some(
      (task) => task.origin === "app_owned" && task.childThreadId === lane.id,
    );
    const delivered = parent.contextTransfers.some(
      (transfer) =>
        transfer.type === "subagent_result" &&
        transfer.sourceThreadId === lane.id &&
        transfer.targetThreadId === parentId &&
        transfer.sourcePoint.runId === lane.latestRunId,
    );
    return appOwned && delivered ? lane.latestRunCompletedAt : null;
  });
});
