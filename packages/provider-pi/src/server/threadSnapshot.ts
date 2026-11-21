import type { OrchestrationV2ProviderThread } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

export function piThreadSnapshot(
  providerThread: OrchestrationV2ProviderThread,
): ProviderAdapter.ProviderAdapterV2ThreadSnapshot {
  return { providerThread, providerTurns: [], messages: [], runtimeRequests: [] };
}
