// User-wide ~/.pi/agent state makes continuation identity use default instance grouping.
import { ProviderDriverKind, type ServerProvider } from "@goat/contracts";
import { PiSettings } from "../settings.ts";
import { OmoSettings } from "../omoSettings.ts";
import { OMO_PROFILE, PI_PROFILE, type PiRuntimeProfile } from "./profile.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { omoUsageReader, piUsageReader } from "./usage.ts";
import { makePiTextGeneration } from "./textGeneration.ts";
import { makePiAdapterV2Driver, type PiAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@goat/provider-core/server/errors";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  discoverPiCommandsForCwd,
  enrichPiSnapshot,
} from "./status.ts";
import { makeManagedServerProvider } from "@goat/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@goat/provider-core/server/driver";
import type { ServerProviderDraft } from "@goat/provider-core/server/snapshotProbe";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@goat/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@goat/provider-core/server/snapshotSettings";

export type PiDriverEnv =
  | PiAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path;

const withInstanceIdentity =
  (input: {
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: input.driver,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

const makePiFamilyDriver = (
  profile: PiRuntimeProfile,
  settingsSchema: Schema.Codec<PiSettings, unknown>,
): ProviderDriver<PiSettings, PiDriverEnv, Path.Path> => {
  const DRIVER_KIND = ProviderDriverKind.make(profile.driver);
  const UPDATE = makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: profile.npmPackage,
    nativeUpdate:
      profile.nativeUpdateArgs === undefined ? null : { args: profile.nativeUpdateArgs },
  });
  const adapterDriver = makePiAdapterV2Driver(profile, settingsSchema);
  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: profile.displayName,
      supportsMultipleInstances: true,
    },
    usage: profile.driver === "pi" ? piUsageReader : omoUsageReader,
    configSchema: settingsSchema,
    defaultConfig: (): PiSettings => Schema.decodeSync(settingsSchema)({}),
    create: Effect.fn("PiDriver.create")(function* ({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const host = yield* ProviderHost.ProviderHost;
      const { cwd } = host.paths;
      const hostEnvironment = yield* HostProcess.Environment;
      const home = yield* HostProcess.HomeDirectory;
      const currentEnvironment = Effect.suspend(() =>
        mergeProviderInstanceEnvironment(environment, hostEnvironment),
      ).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        driver: DRIVER_KIND,
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        currentEnvironment.pipe(
          Effect.flatMap((env) =>
            resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
              binaryPath: effectiveConfig.binaryPath,
              env,
            }),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );

      const orchestrationAdapter = yield* adapterDriver
        .create({
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to build ${profile.displayName} orchestration adapter.`,
                cause,
              }),
          ),
        );
      const textGeneration = yield* makePiTextGeneration(
        effectiveConfig,
        undefined,
        profile,
        currentEnvironment,
      );

      const checkProvider = currentEnvironment.pipe(
        Effect.flatMap((env) => checkPiProviderStatus(effectiveConfig, env, cwd, profile)),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialPiProviderSnapshot(settings.provider, profile).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichPiSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build ${profile.displayName} snapshot.`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: (workspaceCwd) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : Effect.all([
                snapshot.getSnapshot,
                currentEnvironment.pipe(
                  Effect.flatMap((env) =>
                    discoverPiCommandsForCwd(effectiveConfig, env, workspaceCwd, profile),
                  ),
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                  Effect.mapError(
                    (cause) =>
                      new ProviderDriverError({
                        driver: DRIVER_KIND,
                        instanceId,
                        detail: `Failed to discover ${profile.displayName} workspace commands.`,
                        cause,
                      }),
                  ),
                ),
              ]).pipe(
                Effect.map(([machineSnapshot, commands]) => ({
                  ...machineSnapshot,
                  ...commands,
                  slashCommandsPending: false,
                })),
              ),
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
  };
};

export const PiDriver = makePiFamilyDriver(PI_PROFILE, PiSettings);
export const OmoDriver = makePiFamilyDriver(OMO_PROFILE, OmoSettings);
