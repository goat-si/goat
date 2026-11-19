import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ProviderThread,
  RunId,
} from "@goat/contracts";
import { ProviderTurnStartError } from "../ProviderTurnStartTypes.ts";

export function missingProviderSession(runId: RunId, driver: string) {
  return new ProviderTurnStartError({
    runId,
    cause: `Provider ${driver} omitted providerSession metadata.`,
  });
}

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
