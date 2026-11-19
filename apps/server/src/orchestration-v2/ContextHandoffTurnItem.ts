import type {
  ModelSelection,
  NodeId,
  OrchestrationV2ContextHandoff,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import type { IdAllocatorV2 } from "@goat/provider-core/server/IdAllocator";
import type * as DateTime from "effect/DateTime";

export function contextHandoffTurnItem(input: {
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly handoff: OrchestrationV2ContextHandoff;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly selection: ModelSelection;
  readonly sourceRuns: ReadonlyArray<OrchestrationV2Run>;
  readonly ordinal: number;
  readonly now: DateTime.Utc;
  readonly title: string;
}): Extract<OrchestrationV2TurnItem, { readonly type: "handoff" }> {
  const { handoff, now, runId } = input;
  return {
    id: input.idAllocator.derive.runSignalTurnItem({
      runId,
      signal: `context-handoff:${handoff.id}`,
    }),
    threadId: input.threadId,
    runId,
    nodeId: input.rootNodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed",
    title: input.title,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "handoff",
    contextHandoffId: handoff.id,
    fromProviderThreadIds: handoff.fromProviderThreadIds,
    toProviderThreadId: handoff.toProviderThreadId,
    fromProviderInstanceIds: Array.from(
      new Set(input.sourceRuns.map((run) => run.providerInstanceId)),
    ),
    toProviderInstanceId: input.selection.instanceId,
    fromModelSelections: Array.from(
      new Map(
        input.sourceRuns.map((run) => [
          `${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
          run.modelSelection,
        ]),
      ).values(),
    ),
    toModel: input.selection.model,
    strategy: handoff.strategy,
    summary: handoff.summaryText,
  };
}
