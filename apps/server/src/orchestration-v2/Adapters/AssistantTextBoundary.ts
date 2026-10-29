import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const sealedText = Symbol("sealed assistant text");

// A tool boundary seals a line without completing the provider's text item.
export function sealAssistantTextEvent<T extends ProviderAdapter.ProviderAdapterV2Event>(
  event: T,
): T {
  return { ...event, [sealedText]: true };
}

export function hasAssistantTextBoundary(event: ProviderAdapter.ProviderAdapterV2Event): boolean {
  return sealedText in event;
}
