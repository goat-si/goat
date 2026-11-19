import type { ServerProvider, ServerProviderModel } from "@goat/contracts";
import type { AcpRegistryLiveConfiguration } from "./probe.ts";
import { modelsFromDiscovery } from "./discoveredModels.ts";

export function applyAcpRegistryLiveConfiguration(
  provider: ServerProvider,
  configuration: AcpRegistryLiveConfiguration,
  customModels: ReadonlyArray<string>,
  previousModels: ReadonlyArray<ServerProviderModel> = provider.models,
): ServerProvider {
  const { message: _staleProbeMessage, ...snapshot } = provider;
  // session/load may omit models (Kimi returns `{}`); keep the probed list
  // and apply any live option descriptors to it.
  const probedModels = provider.models.filter((model) => !model.isCustom);
  // An explicit model select is authoritative; a lone fallback can be provisional.
  const liveCatalogIsProvisional =
    configuration.models.length === 1 &&
    configuration.modelsFromModelSelect === false &&
    probedModels.length > 1;
  const useLiveCatalog =
    configuration.models.length > 1 ||
    (configuration.models.length === 1 && !liveCatalogIsProvisional);
  const selectedProbedModelId =
    configuration.currentModelId !== null &&
    probedModels.some((model) => model.slug === configuration.currentModelId)
      ? configuration.currentModelId
      : (probedModels.find((model) => model.isDefault)?.slug ?? null);
  const discovery = useLiveCatalog
    ? configuration
    : {
        ...configuration,
        models: probedModels.map((model) => ({
          id: model.slug,
          name: model.name,
          description: null,
        })),
        currentModelId: selectedProbedModelId,
      };
  return {
    ...snapshot,
    status: provider.enabled ? "ready" : provider.status,
    models:
      !useLiveCatalog && configuration.configOptions.length === 0
        ? withAcpRegistryDefaultModel(provider.models, selectedProbedModelId)
        : modelsFromDiscovery(
            discovery,
            customModels,
            previousModels.filter((model) => !model.isCustom),
          ),
  };
}

function withAcpRegistryDefaultModel(
  models: ReadonlyArray<ServerProviderModel>,
  currentModelId: string | null,
): ReadonlyArray<ServerProviderModel> {
  if (currentModelId === null) return models;
  let changed = false;
  const next = models.map((model) => {
    if (model.isCustom) return model;
    const isDefault = model.slug === currentModelId;
    if ((model.isDefault ?? false) === isDefault) return model;
    changed = true;
    const { isDefault: _previous, ...rest } = model;
    return isDefault ? { ...rest, isDefault: true } : rest;
  });
  return changed ? next : models;
}
