import * as CodexRoute from "./CodexRouteService.ts";
import * as Option from "effect/Option";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import {
  CLOUD_SIBLING_DRIVERS,
  defaultInstanceIdForDriver,
  implicitDefaultInstance,
  ProviderDriverKind,
  ProviderInstanceId,
  providerInstanceConfigEnabledFlag,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ServerSettings,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as Settings from "../serverSettings.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "./builtInDrivers.ts";
import { layerProviderHomeInventory } from "./ProviderHomeRuntime.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import type * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import type * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";

type ProviderInstanceRegistryHydrationEnv =
  | Exclude<
      BuiltInDriversEnv,
      | ProviderOrchestrationAdapterInfrastructure.ProviderOrchestrationAdapterInfrastructure
      | AcpRegistrySupport.AcpRegistryCatalog
      | ProviderHost.ProviderHost
    >
  | Settings.ServerSettingsService
  | BackgroundPolicy.BackgroundPolicy
  | ServerConfig.ServerConfig
  | Path.Path
  | FileSystem.FileSystem;

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

export const DEV_REPLAY_INSTANCE_ID = ProviderInstanceId.make("devReplay");

/**
 * Dev servers run from source keep a free ACP agent that replays recorded turns, so UI checks
 * need no paid model. Only settings stored inside this checkout get it, never a live GOAT home.
 * The write waits for the settings watcher to apply it, so it must run after hydration starts.
 */
export const seedDevReplayInstance = Effect.fn(
  "ProviderInstanceRegistryHydration.seedDevReplayInstance",
)(function* () {
  const config = yield* ServerConfig.ServerConfig;
  if (config.devUrl === undefined) return;
  const path = yield* Path.Path;
  const checkoutRoot = yield* path.fromFileUrl(new URL("../../../../", import.meta.url));
  const fromCheckout = path.relative(checkoutRoot, config.settingsPath);
  if (fromCheckout === ".." || fromCheckout.startsWith(`..${path.sep}`)) return;
  if (path.isAbsolute(fromCheckout)) return;
  // Bundled servers, such as desktop dev, have no agent script.
  const agentPath = yield* path.fromFileUrl(
    new URL("../../scripts/dev-replay-agent.ts", import.meta.url),
  );
  if (!(yield* (yield* FileSystem.FileSystem).exists(agentPath))) return;
  const commandPath = yield* HostProcess.ExecutablePath;
  const serverSettings = yield* Settings.ServerSettingsService;
  const existing = (yield* serverSettings.getSettings).providerInstances[DEV_REPLAY_INSTANCE_ID];
  const existingConfig = existing?.config as Record<string, unknown> | undefined;
  // Rewritten only when stale: the node and checkout paths can move.
  if (
    existingConfig?.commandPath === commandPath &&
    (existingConfig.commandArgs as ReadonlyArray<unknown> | undefined)?.[0] === agentPath
  ) {
    return;
  }
  // Keeps user edits, such as turning the provider off.
  const instance: ProviderInstanceConfig = {
    displayName: "Replay (dev)",
    ...existing,
    driver: ProviderDriverKind.make("acpRegistry"),
    config: { ...existingConfig, source: "local", commandPath, commandArgs: [agentPath] },
  };
  yield* serverSettings.updateProviderInstance({
    operation: "upsert",
    instanceId: DEV_REPLAY_INSTANCE_ID,
    instance,
  });
});

// Forked so a slow provider start cannot hold up server startup; the layer scope ends it.
const layerDevReplaySeed = Layer.effectDiscard(
  seedDevReplayInstance().pipe(
    Effect.catchCause((cause) => Effect.logWarning("Dev replay agent unavailable", cause)),
    Effect.forkScoped,
  ),
);

/** Reconciles one settings snapshot; every runtime built from it is bound to its revision. */
export const reconcileSnapshot = (
  mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape,
  configMap: ProviderInstanceConfigMap,
  revision: CodexRoute.SettingsRevision | undefined,
) =>
  mutator.reconcile(configMap).pipe(Effect.provideService(CodexRoute.HydratingRevision, revision));

const settingsWatcher = (
  suppliedChanges?: Stream.Stream<
    {
      readonly settings: ServerSettings;
      readonly revision: CodexRoute.SettingsRevision | undefined;
    },
    import("@goat/contracts").ServerSettingsError
  >,
  initial?: {
    readonly configMap: ProviderInstanceConfigMap;
    readonly revision: CodexRoute.SettingsRevision | undefined;
  },
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
      const serverSettings = yield* Settings.ServerSettingsService;
      const routeState = yield* Effect.serviceOption(CodexRoute.CodexRouteState);
      // Initial hydration runs here, not in the registry layer, so it carries its revision too.
      if (initial !== undefined)
        yield* reconcileSnapshot(mutator, initial.configMap, initial.revision);
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
          Effect.gen(function* () {
            if (next.revision !== undefined)
              return yield* reconcileSnapshot(
                mutator,
                deriveProviderInstanceConfigMap(next.settings),
                next.revision,
              );
            // Read before the settings, so a commit in between can only make this look older.
            const revision = Option.isSome(routeState) ? routeState.value.revision() : undefined;
            const settings = yield* serverSettings.getSettings;
            yield* reconcileSnapshot(mutator, deriveProviderInstanceConfigMap(settings), revision);
          }).pipe(
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
      configMap: {} as ProviderInstanceConfigMap,
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
    const hydrated = settingsWatcher(afterInitial, {
      configMap: initialConfigMap,
      revision: initial?.revision,
    }).pipe(
      Layer.provideMerge(layerMutable),
      Layer.tap(() =>
        Option.isSome(routeState) && initial?.revision
          ? routeState.value.applied(initial.revision)
          : Effect.void,
      ),
    );
    return layerDevReplaySeed.pipe(Layer.provideMerge(hydrated));
  }),
).pipe(
  Layer.provide(ProviderOrchestrationAdapterInfrastructure.layerMemoryAdmission),
) as Layer.Layer<
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  never,
  ProviderInstanceRegistryHydrationEnv
>;

/** The server's registry, with the OpenCodex inventory that routed Home drivers read. */
export const layerWithProviderHome = layer.pipe(Layer.provide(layerProviderHomeInventory));
