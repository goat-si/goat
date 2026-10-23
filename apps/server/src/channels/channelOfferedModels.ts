import type { ModelSelection } from "@goat/contracts";
import * as Schema from "effect/Schema";

/**
 * Only what the model check and placement need from orchestrator_capabilities, so newer fields
 * never break it. An older GOAT may omit driverKind or canRunChildTask; its accounts are then
 * never swapped.
 */
export const OfferedProviders = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      providerInstanceId: Schema.String,
      driverKind: Schema.optional(Schema.String),
      displayName: Schema.optional(Schema.NullOr(Schema.String)),
      /** False for an account that cannot run work now, such as one signed out or disabled. */
      canRunChildTask: Schema.optional(Schema.Boolean),
      models: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  ),
});
export type OfferedProviders = typeof OfferedProviders.Type;
export const decodeOffered = Schema.decodeUnknownEffect(OfferedProviders);

/**
 * The accounts in a capabilities catalog that can run the model: the configured one when it
 * lists the model, or another of the same driver that can take work now and lists it.
 */
export const matchingOfferedProviders = (
  catalog: OfferedProviders,
  model: ModelSelection,
): OfferedProviders["providers"] => {
  const configured = catalog.providers.find(
    (provider) => provider.providerInstanceId === model.instanceId,
  );
  return catalog.providers.filter(
    (provider) =>
      (provider === configured ||
        (configured?.driverKind !== undefined &&
          provider.driverKind === configured.driverKind &&
          provider.canRunChildTask === true)) &&
      provider.models.some((entry) => entry.id === model.model),
  );
};

/**
 * Folds the model entries a targeted capabilities refresh confirmed into the untargeted
 * catalog, so later checks and placement see them. Accounts the catalog lacks are appended
 * whole; existing accounts keep their entries and gain the confirmed ones.
 */
export const mergeOfferedModels = (
  current: OfferedProviders,
  confirmed: OfferedProviders,
): OfferedProviders => ({
  providers: [
    ...current.providers.map((existing) => {
      const update = confirmed.providers.find(
        (provider) => provider.providerInstanceId === existing.providerInstanceId,
      );
      if (update === undefined) return existing;
      const known = new Set(existing.models.map((entry) => entry.id));
      return {
        ...existing,
        models: [...existing.models, ...update.models.filter((entry) => !known.has(entry.id))],
      };
    }),
    ...confirmed.providers.filter(
      (provider) =>
        !current.providers.some(
          (existing) => existing.providerInstanceId === provider.providerInstanceId,
        ),
    ),
  ],
});
