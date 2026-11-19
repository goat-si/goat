import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ProviderThread,
  RunId,
} from "@goat/contracts";
import { ProviderTurnStartError } from "../ProviderTurnStartTypes.ts";

export function missingProviderSession(runId: RunId, driver: string) {
  const error = new ProviderTurnStartError({
    runId,
    cause: `Provider ${driver} omitted providerSession metadata.`,
  });
  error.message = `The ${driver} runtime did not report its session details, so the turn could not start.`;
  return error;
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
