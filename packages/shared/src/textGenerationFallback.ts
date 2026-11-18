import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
  type ProjectId,
  type ServerProvider,
  type ServerSettings,
} from "@goat/contracts";

import { appliesToModel, freshWindows, isWindowExhausted, verdictWindows } from "./quotaVerdict.ts";

export interface TextGenerationFallbackScope {
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  readonly projectId: ProjectId | null;
  /** Without it usage windows are not judged; callers holding provider snapshots pass it. */
  readonly now?: number | undefined;
}

function usageExhausted(provider: ServerProvider, model: string, now: number): boolean {
  const limits = provider.usageLimits;
  if (limits === undefined) return false;
  return freshWindows(verdictWindows(limits), limits.checkedAt, now).some(
    (window) => appliesToModel(window.scopeModel, model) && isWindowExhausted(window, now),
  );
}

/** Upstream's fallback rule (817b92f13a): a provider that can generate text with this model now. */
export function isTextGenerationFallbackCandidate(
  provider: ServerProvider,
  model: string,
  scope: TextGenerationFallbackScope,
): boolean {
  return (
    provider.enabled &&
    resolveProjectProviderInstanceEnabled(scope.settings, scope.projectId, provider.instanceId) &&
    provider.installed &&
    provider.auth.status !== "unauthenticated" &&
    provider.status !== "error" &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider) &&
    (scope.now === undefined || !usageExhausted(provider, model, scope.now))
  );
}
