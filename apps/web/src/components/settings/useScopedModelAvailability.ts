import type { ProviderInstanceId, UnifiedSettings } from "@goat/contracts";
import { isTextGenerationEligible } from "@goat/shared/serverSettings";

import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  getTextGenerationModelOptionsByInstance,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useSettingsScope } from "./SettingsScopeContext";

export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
  textGeneration = false,
  reviewGuideNow?: number,
) {
  const { targets } = useSettingsScope();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  return (
    instanceId: ProviderInstanceId,
    model: string,
    { includeHidden = false }: { includeHidden?: boolean } = {},
  ): string | null => {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    for (const candidate of targets) {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      const providers = providersByEnvironment.get(candidate.environmentId);
      if (!environment?.serverConfig || !providers) continue;
      const entry = applyProviderInstanceSettings(
        deriveProviderInstanceEntries(providers),
        candidate.settings,
        candidate.projectId,
      ).find((option) => option.instanceId === instanceId);
      const optionsForInstance = textGeneration
        ? getTextGenerationModelOptionsByInstance
        : getCustomModelOptionsByInstance;
      const merged = mergeEnvironmentSettings(candidate.settings, settings);
      const options = optionsForInstance(
        includeHidden ? { ...merged, providerModelPreferences: {} } : merged,
        providers,
      ).get(instanceId);
      if (
        !entry?.enabled ||
        !entry.isAvailable ||
        entry.driverKind !== sourceEntry?.driverKind ||
        !options?.some((option) => option.slug === model && !option.isUnavailable) ||
        (reviewGuideNow !== undefined &&
          !isTextGenerationEligible(
            merged,
            { instanceId, model },
            providers.find((provider) => provider.instanceId === instanceId),
            { projectId: candidate.projectId, now: reviewGuideNow, purpose: "reviewGuide" },
          ))
      ) {
        return `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
      }
    }
    return null;
  };
}
