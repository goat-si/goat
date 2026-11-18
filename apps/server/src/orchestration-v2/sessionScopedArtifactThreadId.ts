import type { ThreadId } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

export function sessionScopedArtifactThreadId(
  event: ProviderAdapter.ProviderAdapterV2Event,
): ThreadId | undefined {
  switch (event.type) {
    case "provider_thread.updated":
      return event.sessionScoped === true
        ? (event.providerThread.appThreadId ?? undefined)
        : undefined;
    case "runtime_request.updated":
      return event.runtimeRequest.providerTurnId === null ? event.threadId : undefined;
    case "node.updated":
      if (event.sessionScoped === true && event.node.kind === "subagent")
        return event.node.threadId;
      return event.node.runId === null && event.node.runtimeRequestId !== null
        ? event.node.threadId
        : undefined;
    case "subagent.updated":
      return event.sessionScoped === true && event.subagent.origin === "provider_native"
        ? event.subagent.threadId
        : undefined;
    case "turn_item.updated":
      if (
        event.turnItem.type === "command_execution" ||
        (event.turnItem.type === "subagent" && event.turnItem.origin === "provider_native")
      )
        return event.sessionScoped === true ? event.turnItem.threadId : undefined;
      return event.turnItem.runId === null &&
        (event.turnItem.type === "approval_request" || event.turnItem.type === "user_input_request")
        ? event.turnItem.threadId
        : undefined;
    default:
      return undefined;
  }
}

/** Background snapshots persist only into threads still attached to the session. */
export const needsAttached = (event: ProviderAdapter.ProviderAdapterV2Event) =>
  "sessionScoped" in event && event.sessionScoped === true;
