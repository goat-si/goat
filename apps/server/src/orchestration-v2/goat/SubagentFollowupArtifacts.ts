import type {
  NodeId,
  OrchestrationV2Command,
  OrchestrationV2ExecutionNode,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";

export function subagentFollowupArtifacts(input: {
  readonly command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
  readonly original: OrchestrationV2Subagent;
  readonly owner: OrchestrationV2Run & { readonly rootNodeId: NodeId };
  readonly run: OrchestrationV2Run;
  readonly taskId: NodeId;
  readonly parentThreadId: ThreadId;
  readonly childId: ThreadId;
  readonly title: string;
  readonly now: DateTime.Utc;
  readonly driver: ProviderDriverKind;
  readonly turnItemId: TurnItemId;
  readonly providerTurnId: ProviderTurnId | null;
  readonly turnItemOrdinal: number;
}) {
  const {
    command,
    original,
    owner,
    run,
    taskId,
    parentThreadId,
    childId,
    title,
    now,
    driver,
    turnItemId,
    providerTurnId,
    turnItemOrdinal,
  } = input;
  const task: OrchestrationV2Subagent = {
    ...original,
    parentModelSelection: owner.modelSelection,
    reviewLedger: undefined,
    memoryGrantCeiling: command.memoryGrantCeiling ?? "none",
    createdBy: command.createdBy,
    driver: driver,
    id: taskId,
    runId: owner.id,
    parentNodeId: owner.rootNodeId,
    providerInstanceId: run.providerInstanceId,
    providerThreadId: run.providerThreadId,
    model: run.modelSelection.model,
    modelSelection: run.modelSelection,
    prompt: command.text,
    title: title,
    completionWake: "always",
    completionDelivery: { state: "pending", observedByRunId: null },
    status: run.status === "queued" ? (run.queueHeld === true ? "idle" : "pending") : "running",
    progress: undefined,
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  const node: OrchestrationV2ExecutionNode = {
    id: taskId,
    threadId: parentThreadId,
    runId: owner.id,
    parentNodeId: owner.rootNodeId,
    rootNodeId: owner.rootNodeId,
    kind: "subagent",
    status: task.status,
    countsForRun: false,
    providerThreadId: run.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
  const turnItem: OrchestrationV2TurnItem = {
    id: turnItemId,
    threadId: parentThreadId,
    runId: owner.id,
    nodeId: taskId,
    providerThreadId: owner.providerThreadId,
    providerTurnId: providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: turnItemOrdinal,
    status: task.status,
    title: title,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "subagent",
    subagentId: taskId,
    origin: "app_owned",
    driver: task.driver,
    providerInstanceId: task.providerInstanceId,
    childThreadId: childId,
    prompt: command.text,
    result: null,
  };
  return { task, node, turnItem };
}
