import type { ProviderOptionDescriptor, ServerProviderModel } from "@goat/contracts";

import type { CodexAppServerProviderSnapshot } from "./CodexProvider.ts";

function mapCodexOptionDescriptors(
  models: ReadonlyArray<ServerProviderModel>,
  update: (
    descriptors: ReadonlyArray<ProviderOptionDescriptor>,
    model: ServerProviderModel,
  ) => ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    if (!model.capabilities?.optionDescriptors) return model;
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        optionDescriptors: update(model.capabilities.optionDescriptors, model),
      },
    };
  });
}

function withConfiguredSelectDefault(
  models: ReadonlyArray<ServerProviderModel>,
  descriptorId: string,
  pick: (options: ReadonlyArray<{ readonly id: string }>) => string | undefined,
): ReadonlyArray<ServerProviderModel> {
  return mapCodexOptionDescriptors(models, (descriptors) =>
    descriptors.map((descriptor) => {
      if (descriptor.id !== descriptorId || descriptor.type !== "select") return descriptor;
      const value = pick(descriptor.options);
      if (!value) return descriptor;
      return {
        ...descriptor,
        currentValue: value,
        options: descriptor.options.map(({ isDefault: _isDefault, ...option }) =>
          option.id === value ? { ...option, isDefault: true } : option,
        ),
      };
    }),
  );
}

function applyConfiguredCodexServiceTier(
  models: ReadonlyArray<ServerProviderModel>,
  serviceTier: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!serviceTier) return models;
  return withConfiguredSelectDefault(
    models,
    "serviceTier",
    (options) =>
      options.find(
        (option) =>
          option.id === serviceTier || (serviceTier === "fast" && option.id === "priority"),
      )?.id,
  );
}

/** Mirrors Codex: `daybreak = true` prefers a Daybreak program, Blue before Red. */
function applyConfiguredCodexCyberAccess(
  models: ReadonlyArray<ServerProviderModel>,
  snapshot: Pick<
    CodexAppServerProviderSnapshot,
    "daybreakEnabled" | "cyberAccessProgramsUnavailable"
  >,
): ReadonlyArray<ServerProviderModel> {
  // Without a descriptor no turn sends a program; without a default only an explicit choice goes.
  const offered = mapCodexOptionDescriptors(models, (descriptors, model) =>
    descriptors.flatMap((descriptor): ReadonlyArray<ProviderOptionDescriptor> => {
      if (descriptor.id !== "cyberAccessProgram" || descriptor.type !== "select") {
        return [descriptor];
      }
      if (model.isCustom || snapshot.cyberAccessProgramsUnavailable === true) return [];
      if (snapshot.daybreakEnabled !== undefined) return [descriptor];
      const { currentValue: _currentValue, ...withoutDefault } = descriptor;
      return [
        {
          ...withoutDefault,
          options: descriptor.options.map(({ isDefault: _isDefault, ...option }) => option),
        },
      ];
    }),
  );
  if (snapshot.daybreakEnabled !== true) return offered;
  return withConfiguredSelectDefault(offered, "cyberAccessProgram", (options) =>
    ["daybreakBlue", "daybreakRed"].find((program) =>
      options.some((option) => option.id === program),
    ),
  );
}

export { applyConfiguredCodexCyberAccess, applyConfiguredCodexServiceTier };
