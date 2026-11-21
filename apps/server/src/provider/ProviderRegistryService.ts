import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUpdateState,
} from "@goat/contracts";
import type { ProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderMaintenanceActionKind = "update";

export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  {
    readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
    readonly rescanGlobalSkills?: Effect.Effect<ReadonlyArray<ServerProvider>>;

    readonly refresh: (
      provider?: ProviderDriverKind,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Resolves once no untargeted refresh is in flight. `refresh()` joins a running pass, which
     * may already have checked a provider; a refresh begun after this reads current state.
     * Optional like the members above: a registry with no shared pass has nothing to wait for.
     */
    readonly awaitInFlightRefresh?: Effect.Effect<void>;

    /** Unknown instance ids return the cached list without error. */
    readonly refreshInstance: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
    readonly reloadSecretsAndRefresh?: (
      instanceId?: ProviderInstanceId,
      checked?: import("./ProviderInstanceRegistryMutator.ts").CheckedSecret,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /** Only refreshed instances can verify an update; the published list still includes every row. */
    readonly refreshAfterUpdate: (
      provider: ProviderDriverKind,
      selectedInstanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    readonly refreshWorkspaceSnapshot: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly cwd: string;
      /** Directory the driver scans; the snapshot stays keyed by `cwd`. Defaults to `cwd`. */
      readonly scanCwd?: string;
      readonly fresh?: boolean;
    }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Drop GOAT-owned model caches before an explicit model refresh. Pass the
     * target of the refresh that follows. Background and ordinary refreshes
     * keep their cache timers and must not call this.
     */
    readonly invalidateModelCaches: (input: {
      readonly instanceId?: ProviderInstanceId | undefined;
      readonly cwd?: string | undefined;
      readonly fresh?: boolean | undefined;
    }) => Effect.Effect<void>;
    readonly refreshModelCatalog: Effect.Effect<void>;

    readonly getProviderMaintenanceCapabilitiesForInstance: (
      instanceId: ProviderInstanceId,
      provider: ProviderDriverKind,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<ProviderMaintenanceCapabilities>;

    readonly setProviderMaintenanceActionState: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: ProviderMaintenanceActionKind;
      readonly state: ServerProviderUpdateState | null;
      readonly targetVersion?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
  }
  // @effect-diagnostics-next-line deterministicKeys:off -- Preserve the service key across the move.
>()("goat/provider/ProviderRegistry") {}
