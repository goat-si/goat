import {
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
  type ProjectId,
} from "@goat/contracts";

export function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (!provider.enabled) {
    constraints.push("Provider instance is disabled.");
    // Disabled snapshots contain placeholders for installation, health, and auth.
    return constraints;
  }
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

export function providerForCaller(
  provider: ServerProvider,
  settings: ServerSettings,
  projectId: ProjectId | undefined,
): ServerProvider {
  return projectId === undefined ||
    resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId)
    ? provider
    : { ...provider, enabled: false };
}
