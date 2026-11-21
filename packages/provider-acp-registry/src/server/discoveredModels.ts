import type { CustomModelSetting } from "@goat/contracts";
import type { AcpRegistryProbeModel, ServerProviderModel } from "@goat/contracts";
import { createModelCapabilities } from "@goat/shared/model";
import { providerModelsFromSettings } from "@goat/provider-core/server/snapshotProbe";
import type { AcpRegistryLiveConfiguration } from "./probe.ts";

const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

export function modelsFromDiscovery(
  discovery:
    | Pick<
        AcpRegistryLiveConfiguration,
        "models" | "currentModelId" | "configOptions" | "modelOptionIds"
      >
    | undefined,
  customModels: ReadonlyArray<CustomModelSetting>,
  previousModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  const discovered = discovery?.models ?? [];
  const capabilities =
    discovery === undefined || discovery.configOptions.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({ optionDescriptors: discovery.configOptions });
  const modelOptionIds = new Set(discovery?.modelOptionIds ?? []);
  const shared = (discovery?.configOptions ?? []).filter(
    (descriptor) => !modelOptionIds.has(descriptor.id),
  );
  const sharedIds = new Set(shared.map((descriptor) => descriptor.id));
  const capabilitiesFor = ({ id: slug, reasoningEffort }: AcpRegistryProbeModel) => {
    const isCurrent = slug === discovery?.currentModelId;
    if (isCurrent && reasoningEffort === undefined) return capabilities;
    const inherited = isCurrent
      ? (capabilities.optionDescriptors ?? [])
      : [
          ...shared,
          ...(
            previousModels.find((model) => model.slug === slug)?.capabilities?.optionDescriptors ??
            []
          ).filter((descriptor) => !sharedIds.has(descriptor.id)),
        ];
    const optionDescriptors =
      reasoningEffort === undefined
        ? inherited
        : [
            ...inherited.filter(
              (descriptor) =>
                descriptor.id !== reasoningEffort?.id &&
                !(descriptor.type === "select" && descriptor.role === "reasoning"),
            ),
            ...(reasoningEffort === null ? [] : [reasoningEffort]),
          ];
    return optionDescriptors.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({ optionDescriptors });
  };
  const builtInModels: ReadonlyArray<ServerProviderModel> =
    discovered.length === 0
      ? [
          {
            slug: "default",
            name: "Default",
            isCustom: false,
            isDefault: true,
            capabilities,
          },
        ]
      : discovered.map((model) => ({
          slug: model.id,
          name: model.name,
          isCustom: false,
          ...(model.id === discovery?.currentModelId ? { isDefault: true } : {}),
          capabilities: capabilitiesFor(model),
        }));
  return providerModelsFromSettings(builtInModels, customModels, capabilities);
}
