import type { ProviderInstanceId } from "@goat/contracts";

export function acpSupportsImagePrompts(input: {
  readonly flavorSupportsImagePrompts?: boolean | undefined;
  readonly negotiatedImage?: boolean | undefined;
}): boolean {
  return input.flavorSupportsImagePrompts === true || input.negotiatedImage === true;
}

export function acpScopedNativeId(instanceId: ProviderInstanceId, nativeId: string): string {
  return `provider-instance:${encodeURIComponent(instanceId)}:${nativeId}`;
}

export function acpProviderItemNativeId(input: {
  readonly instanceId: ProviderInstanceId;
  readonly itemIdentityVersion: 2 | undefined;
  readonly nativeId: string;
}): string {
  return input.itemIdentityVersion === 2
    ? acpScopedNativeId(input.instanceId, input.nativeId)
    : input.nativeId;
}

export function nonEmptyText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}
