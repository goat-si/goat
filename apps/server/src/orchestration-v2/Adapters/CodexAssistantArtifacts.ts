import {
  ProviderDriverKind,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProviderThread,
  type ProviderTurnId,
  type NodeId,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as DateTime from "effect/DateTime";
const CODEX_PROVIDER = ProviderDriverKind.make("codex");
export function buildCodexAssistantArtifacts(
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
  context: {
    projectionThreadId: ThreadId;
    projectionRunId: RunId | null;
    itemParentNodeId: NodeId;
    rootNodeId: NodeId;
    providerThread: OrchestrationV2ProviderThread;
    providerTurnId: ProviderTurnId;
  },
  item: { id: string; text: string },
  completed: boolean,
  ordinal: number,
  startedAt: DateTime.Utc,
  updatedAt: DateTime.Utc,
) {
  const completedAt = completed ? updatedAt : null;
  const nodeId = idAllocator.derive.nodeFromProviderItem({
    driver: CODEX_PROVIDER,
    nativeItemId: item.id,
  });
  const messageId = idAllocator.derive.messageFromProviderItem({
    driver: CODEX_PROVIDER,
    nativeItemId: item.id,
  });
  const turnItemId = idAllocator.derive.turnItemFromProviderItem({
    driver: CODEX_PROVIDER,
    nativeItemId: item.id,
  });
  const node: OrchestrationV2ExecutionNode = {
    id: nodeId,
    threadId: context.projectionThreadId,
    runId: context.projectionRunId,
    parentNodeId: context.itemParentNodeId,
    rootNodeId: context.rootNodeId,
    kind: "assistant_message",
    status: completed ? "completed" : "running",
    countsForRun: false,
    providerThreadId: context.providerThread.id,
    providerTurnId: context.providerTurnId,
    nativeItemRef: { driver: CODEX_PROVIDER, nativeId: item.id, strength: "strong" },
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt,
    completedAt,
  };
  const message: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "provider",
    id: messageId,
    threadId: context.projectionThreadId,
    runId: context.projectionRunId,
    nodeId,
    role: "assistant",
    text: item.text,
    attachments: [],
    streaming: !completed,
    createdAt: startedAt,
    updatedAt,
  };
  const turnItem = {
    id: turnItemId,
    threadId: context.projectionThreadId,
    runId: context.projectionRunId,
    nodeId,
    providerThreadId: context.providerThread.id,
    providerTurnId: context.providerTurnId,
    nativeItemRef: { driver: CODEX_PROVIDER, nativeId: item.id, strength: "strong" },
    parentItemId: null,
    ordinal,
    status: completed ? "completed" : "running",
    title: null,
    startedAt,
    completedAt,
    updatedAt,
    type: "assistant_message",
    messageId,
    text: item.text,
    streaming: !completed,
  } satisfies OrchestrationV2TurnItem;
  return { node, message, turnItem };
}
