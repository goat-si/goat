/** Reconcile closes removed/replaced scopes before creating replacements: at most one live instance per id. */
import type {
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  SecretReference,
  ServerSettings,
} from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** A secret Settings' Check read just now; a reload uses it instead of reading it again. */
export interface CheckedSecret {
  readonly reference: SecretReference;
  readonly value: string;
}

export interface ProviderInstanceRegistryMutatorShape {
  readonly reconcile: (
    configMap: ProviderInstanceConfigMap,
    secretProviders?: ServerSettings["secretProviders"],
    deferSecrets?: boolean,
  ) => Effect.Effect<void>;
  readonly reloadSecrets?: (
    instanceId?: ProviderInstanceId,
    checked?: CheckedSecret,
  ) => Effect.Effect<void>;
  readonly hydrateSecrets?: () => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("goat/provider/ProviderInstanceRegistryMutator") {}
