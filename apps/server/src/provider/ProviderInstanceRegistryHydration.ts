import * as CodexRoute from "./CodexRouteService.ts";
import * as Option from "effect/Option";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import {
  CLOUD_SIBLING_DRIVERS,
  defaultInstanceIdForDriver,
  implicitDefaultInstance,
  providerInstanceConfigEnabledFlag,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  ServerSettings,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Settings from "../serverSettings.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "./builtInDrivers.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import type * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import type * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import type * as ServerConfig from "../config.ts";

type ProviderInstanceRegistryHydrationEnv =
  | Exclude<
      BuiltInDriversEnv,
      | ProviderOrchestrationAdapterInfrastructure.ProviderOrchestrationAdapterInfrastructure
      | AcpRegistrySupport.AcpRegistryCatalog
      | ProviderHost.ProviderHost
    >
  | Settings.ServerSettingsService
  | BackgroundPolicy.BackgroundPolicy
  | ServerConfig.ServerConfig;

export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const driver of BUILT_IN_DRIVERS) {
    if (driver.metadata.hasDefaultInstance === false) continue;
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) continue;
    const implicit = implicitDefaultInstance(settings, driver.driverKind);
    if (!implicit.present) continue;
    merged[instanceId] = Object.hasOwn(CLOUD_SIBLING_DRIVERS, driver.driverKind)
      ? { driver: driver.driverKind, enabled: implicit.enabled }
      : { driver: driver.driverKind };
  }

  // Probe project-enabled instances even if disabled machine-wide; project threads can still route to them.
  for (const overrides of Object.values(settings.projectSettingsOverrides)) {
    for (const [rawInstanceId, projectOverride] of Object.entries(
      overrides?.providerInstances ?? {},
    )) {
      if (projectOverride.enabled !== true) continue;
      const instanceId = rawInstanceId as ProviderInstanceId;
      const existing = merged[instanceId];
      if (existing === undefined || resolveProviderInstanceEnabled(existing)) continue;
      merged[instanceId] = {
        ...existing,
        enabled: true,
        ...(providerInstanceConfigEnabledFlag(existing.config) === false
          ? { config: { ...(existing.config as Record<string, unknown>), enabled: true } }
          : {}),
      };
    }
  }

  return merged as ProviderInstanceConfigMap;
};

const settingsWatcher = (
  suppliedChanges?: Stream.Stream<
    {
      readonly settings: ServerSettings;
      readonly revision: CodexRoute.SettingsRevision | undefined;
    },
    import("@goat/contracts").ServerSettingsError
  >,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
      const serverSettings = yield* Settings.ServerSettingsService;
      const routeState = yield* Effect.serviceOption(CodexRoute.CodexRouteState);
      const settingsChanges: Stream.Stream<
        {
          readonly settings: ServerSettings;
          readonly revision: CodexRoute.SettingsRevision | undefined;
        },
        import("@goat/contracts").ServerSettingsError
      > =
        suppliedChanges ??
        (serverSettings.subscribeProviderChanges
          ? yield* serverSettings.subscribeProviderChanges
          : (yield* serverSettings.subscribeChanges).pipe(
              Stream.map((settings) => ({ settings, revision: undefined })),
            ));
      yield* settingsChanges.pipe(
        Stream.runForEach((next) =>
          (next.revision === undefined
            ? serverSettings.getSettings
            : Effect.succeed(next.settings)
          ).pipe(
            Effect.flatMap((current) =>
              mutator.reconcile(deriveProviderInstanceConfigMap(current)),
            ),
            Effect.tap(() =>
              Option.isSome(routeState) && next.revision
                ? routeState.value.applied(next.revision)
                : Effect.void,
            ),
            Effect.tapCause(() =>
              Option.isSome(routeState) && next.revision
                ? routeState.value.applied(next.revision, true)
                : Effect.void,
            ),
            Effect.catchCause((cause) =>
              Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
            ),
          ),
        ),
        Effect.onExit(() =>
          Option.isSome(routeState) ? routeState.value.watcherStopped : Effect.void,
        ),
        Effect.catchCause((cause) => Effect.logError("Provider settings watcher stopped", cause)),
        Effect.forkScoped,
      );
    }),
  );

export const layerSettingsWatcher = settingsWatcher();

export const layer: Layer.Layer<
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  never,
  ProviderInstanceRegistryHydrationEnv
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    const routeState = yield* Effect.serviceOption(CodexRoute.CodexRouteState);
    const changes: Stream.Stream<
      {
        readonly settings: ServerSettings;
        readonly revision: CodexRoute.SettingsRevision | undefined;
      },
      import("@goat/contracts").ServerSettingsError
    > = serverSettings.subscribeProviderChanges
      ? yield* serverSettings.subscribeProviderChanges
      : (yield* serverSettings.subscribeChanges).pipe(
          Stream.map((settings) => ({ settings, revision: undefined })),
        );
    const admission = yield* ProviderOrchestrationAdapterInfrastructure.ProviderMemoryAdmission;
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    // Override only the adapter construction context. The manager retains the raw slot.
    const fencedSessions = McpProviderSessions.McpProviderSessions.of({
      ...sessions,
      read: (threadId) => sessions.read(threadId).pipe(Effect.flatMap(admission.fence)),
    });
    const initial = yield* serverSettings
      .withSettingsSnapshot((settings) =>
        Effect.sync(() => ({
          settings,
          revision: Option.isSome(routeState) ? routeState.value.revision() : undefined,
        })),
      )
      .pipe(Effect.orElseSucceed(() => undefined));
    const initialConfigMap =
      initial === undefined
        ? ({} as ProviderInstanceConfigMap)
        : deriveProviderInstanceConfigMap(initial.settings);

    const layerMutable = ProviderInstanceRegistry.layer({
      drivers: BUILT_IN_DRIVERS,
      configMap: initialConfigMap,
    }).pipe(
      Layer.provide(ProviderOrchestrationAdapterInfrastructure.layer),
      Layer.provide(Layer.succeed(McpProviderSessions.McpProviderSessions, fencedSessions)),
      Layer.provide(
        Layer.succeed(
          ProviderOrchestrationAdapterInfrastructure.ProviderMemoryAdmission,
          admission,
        ),
      ),
      Layer.provide(AcpRegistrySupport.layerFromHost),
      Layer.provide(ProviderHostLive.layer),
    );

    const afterInitial = changes.pipe(
      Stream.filter(
        (event) =>
          event.revision === undefined ||
          initial?.revision === undefined ||
          event.revision.epoch !== initial.revision.epoch ||
          event.revision.sequence > initial.revision.sequence,
      ),
    );
    return settingsWatcher(afterInitial).pipe(
      Layer.provideMerge(layerMutable),
      Layer.tap(() =>
        Option.isSome(routeState) && initial?.revision
          ? routeState.value.applied(initial.revision)
          : Effect.void,
      ),
    );
  }),
).pipe(
  Layer.provide(ProviderOrchestrationAdapterInfrastructure.layerMemoryAdmission),
) as Layer.Layer<
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  never,
  ProviderInstanceRegistryHydrationEnv
>;
