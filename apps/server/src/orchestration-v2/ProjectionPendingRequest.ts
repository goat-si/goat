import {
  RuntimeRequestId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2PendingRuntimeRequestSummary,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";

export function pendingRuntimeRequestSummary(
  request: OrchestrationV2ThreadProjection["runtimeRequests"][number] | null,
): OrchestrationV2PendingRuntimeRequestSummary | null {
  if (request === null) return null;
  return {
    id: request.id,
    kind: request.kind,
    createdAt: request.createdAt,
    blocking: request.responseCapability.type !== "message",
  };
}

export function secretRequestAsPendingInput(
  item: OrchestrationV2TurnItem | null,
): OrchestrationV2PendingRuntimeRequestSummary | null {
  if ((item?.type !== "secret_request" && item?.type !== "human_handoff") || item.nodeId === null)
    return null;
  return {
    id: RuntimeRequestId.make(item.id),
    kind: "user_input",
    createdAt: item.startedAt ?? item.updatedAt,
    blocking: true,
  };
}
