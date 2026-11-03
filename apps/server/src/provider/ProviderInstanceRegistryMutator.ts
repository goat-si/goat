/** Reconcile closes removed/replaced scopes before creating replacements: at most one live instance per id. */
import type {
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ServerSettings,
} from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderInstanceRegistryMutatorShape {
  readonly reconcile: (
    configMap: ProviderInstanceConfigMap,
    secretProviders?: ServerSettings["secretProviders"],
    deferSecrets?: boolean,
  ) => Effect.Effect<void>;
  readonly reloadSecrets?: (instanceId?: ProviderInstanceId) => Effect.Effect<void>;
  readonly hydrateSecrets?: () => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("goat/provider/ProviderInstanceRegistryMutator") {}
