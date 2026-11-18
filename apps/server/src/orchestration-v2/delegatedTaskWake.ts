import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
} from "@goat/contracts";

/** Matches planDelegatedCompletionDelivery: true while a delegated task's result still wakes the thread. */
export const delegatedTaskWillWake = (records: {
  readonly thread: Pick<OrchestrationV2AppThread, "archivedAt" | "deletedAt">;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "delegatedCompletion">>;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "origin" | "status" | "runId" | "completionDelivery">
  >;
}): boolean =>
  records.thread.archivedAt === null &&
  records.thread.deletedAt === null &&
  records.subagents.some((task) => {
    const run = records.runs.find((candidate) => candidate.id === task.runId);
    const delivery = task.completionDelivery?.state;
    return (
      task.origin === "app_owned" &&
      isOrchestrationV2WorkActive(task.status) &&
      run !== undefined &&
      (run.delegatedCompletion?.disposition ?? "open") === "open" &&
      delivery !== "acknowledged" &&
      delivery !== "delivered" &&
      delivery !== "disposed"
    );
  });
