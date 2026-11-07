import { PREFERRED_DEFAULT_CODEX_MODELS, type ServerProviderModel } from "@goat/contracts";
import { codexModelFamily } from "@goat/shared/model";

export function applyPreferredCodexDefaultModel(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const preferredSlug = PREFERRED_DEFAULT_CODEX_MODELS.flatMap((slug) =>
    models.filter((model) => !model.isCustom && codexModelFamily(model.slug) === slug),
  )[0]?.slug;
  if (!preferredSlug) return models;
  return models.map((model) => {
    if (model.slug === preferredSlug)
      return model.isDefault ? model : { ...model, isDefault: true };
    if (!model.isDefault) return model;
    const { isDefault: _isDefault, ...rest } = model;
    return rest;
  });
}
