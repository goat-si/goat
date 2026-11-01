import type {
  OrchestrationV2ContextTransfer,
  OrchestrationV2Subagent,
  ThreadId,
} from "@goat/contracts";

/**
 * What a reader saw of a delegated task: how many results its child has reported here, and
 * whether it was promoted. Each result adds its own transfer, so the count only grows; an
 * acknowledgement made for one view must not cover a later result.
 */
export const delegatedTaskRevision = (
  parentThreadId: ThreadId,
  contextTransfers: ReadonlyArray<OrchestrationV2ContextTransfer>,
  task: Pick<OrchestrationV2Subagent, "childThreadId" | "promotedAt">,
) => ({
  resultCount: contextTransfers.filter(
    (transfer) =>
      transfer.type === "subagent_result" &&
      transfer.targetThreadId === parentThreadId &&
      task.childThreadId !== null &&
      transfer.sourceThreadId === task.childThreadId,
  ).length,
  promoted: task.promotedAt !== undefined,
});

type DelegatedTaskRevision = ReturnType<typeof delegatedTaskRevision>;

export const sameDelegatedTaskRevision = (
  left: DelegatedTaskRevision,
  right: DelegatedTaskRevision,
) => left.resultCount === right.resultCount && left.promoted === right.promoted;
