import type { OrchestrationV2RuntimeRequest, ProviderSessionId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import type { ProviderSessionReleaseReason } from "./ProviderSessionManager.ts";

export function isReleasedRuntimeRequest(
  request: OrchestrationV2RuntimeRequest,
  providerSessionId: ProviderSessionId,
  releasedAt: DateTime.Utc,
  reason: ProviderSessionReleaseReason,
): boolean {
  return (
    request.status === "pending" &&
    request.responseCapability.type === "live" &&
    request.responseCapability.providerSessionId === providerSessionId &&
    DateTime.isLessThanOrEqualTo(request.createdAt, releasedAt) &&
    // Shutdown recovery decides whether a question survives the lost callback.
    !(reason === "server_shutdown" && request.kind === "user_input")
  );
}
