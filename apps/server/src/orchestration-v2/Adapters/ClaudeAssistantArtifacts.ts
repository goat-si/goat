import {
  ProviderDriverKind,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProviderTurn,
} from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as DateTime from "effect/DateTime";
const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");
export function buildAssistantArtifacts(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly nativeItemId: string;
  readonly text: string;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  readonly completedAt: DateTime.Utc;
  readonly streaming?: boolean | undefined;
}): {
  readonly node: OrchestrationV2ExecutionNode;
  readonly message: OrchestrationV2ConversationMessage;
  readonly turnItem: OrchestrationV2TurnItem;
} {
  const nodeId = input.idAllocator.derive.nodeFromProviderItem({
    driver: CLAUDE_PROVIDER,
    nativeItemId: input.nativeItemId,
  });
  const messageId = input.idAllocator.derive.messageFromProviderItem({
    driver: CLAUDE_PROVIDER,
    nativeItemId: input.nativeItemId,
  });
  const turnItemId = input.idAllocator.derive.turnItemFromProviderItem({
    driver: CLAUDE_PROVIDER,
    nativeItemId: input.nativeItemId,
  });
  const nativeItemRef = {
    driver: CLAUDE_PROVIDER,
    nativeId: input.nativeItemId,
    strength: "strong" as const,
  };

  return {
    node: {
      id: nodeId,
      threadId: input.turnInput.threadId,
      runId: input.turnInput.runId,
      parentNodeId: input.turnInput.rootNodeId,
      rootNodeId: input.turnInput.rootNodeId,
      kind: "assistant_message",
      status: input.streaming ? "running" : "completed",
      countsForRun: false,
      providerThreadId: input.turnInput.providerThread.id,
      providerTurnId: input.providerTurnId,
      nativeItemRef,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: input.startedAt,
      completedAt: input.streaming ? null : input.completedAt,
    },
    message: {
      createdBy: "agent",
      creationSource: "provider",
      id: messageId,
      threadId: input.turnInput.threadId,
      runId: input.turnInput.runId,
      nodeId,
      role: "assistant",
      text: input.text,
      attachments: [],
      streaming: input.streaming ?? false,
      createdAt: input.completedAt,
      updatedAt: input.completedAt,
    },
    turnItem: {
      id: turnItemId,
      threadId: input.turnInput.threadId,
      runId: input.turnInput.runId,
      nodeId,
      providerThreadId: input.turnInput.providerThread.id,
      providerTurnId: input.providerTurnId,
      nativeItemRef,
      parentItemId: null,
      ordinal: input.ordinal,
      status: input.streaming ? "running" : "completed",
      title: null,
      startedAt: input.startedAt,
      completedAt: input.streaming ? null : input.completedAt,
      updatedAt: input.completedAt,
      type: "assistant_message",
      messageId,
      text: input.text,
      streaming: input.streaming ?? false,
    },
  };
}
