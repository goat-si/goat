import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ProviderThread,
} from "@goat/contracts";

export function hasPendingHandoff(
  projection: Pick<OrchestrationV2ThreadProjection, "contextHandoffs">,
  providerThread: OrchestrationV2ProviderThread,
) {
  return projection.contextHandoffs.some(
    (handoff) =>
      handoff.toProviderThreadId === providerThread.id &&
      handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
      handoff.delivery?.status === "pending",
  );
}
