import type { ProviderOptionSelection, ServerProvider } from "@goat/contracts";
import { advertisedModel } from "./ModelSelectionValidation.ts";
import { overrideOptionSelections } from "./modelOptionOverrides.ts";

export function antigravityDelegatedModel(provider: ServerProvider, model: string | undefined) {
  if (model === undefined || provider.driver !== "antigravity" || advertisedModel(provider, model))
    return;
  const separator = model.lastIndexOf("-");
  if (separator === -1) return;
  const family = model.slice(0, separator);
  const value = model.slice(separator + 1);
  const thinking = provider.models
    .find((candidate) => candidate.slug === family)
    ?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.type === "select" && descriptor.role === "reasoning",
    );
  if (thinking?.type === "select" && thinking.options.some((choice) => choice.id === value)) {
    return { model: family, thinking: { id: thinking.id, value } };
  }
}

export function delegatedOptions(
  inherited: ReadonlyArray<ProviderOptionSelection> | undefined,
  requested: ReadonlyArray<ProviderOptionSelection> | undefined,
  thinking: ProviderOptionSelection | undefined,
) {
  const base =
    thinking && requested?.length !== 0
      ? overrideOptionSelections(inherited, [thinking])
      : inherited;
  return overrideOptionSelections(base, requested);
}
