import { ProviderDriverKind, ProviderSetupError, type ServerProvider } from "@goat/contracts";
import { GrokSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import { makeGrokTextGeneration } from "./textGeneration.ts";
import { GrokAdapterV2Driver, type GrokAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@goat/provider-core/server/errors";
import {
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  enrichGrokSnapshot,
} from "./status.ts";
import { grokUsageReader } from "./usage.ts";
import { readGrokAccount } from "./usageLimits.ts";
import { makeManagedServerProvider } from "@goat/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@goat/provider-core/server/driver";
import { withInstanceIdentity } from "@goat/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import {
  applyStoredGrokApiKey,
  GROK_API_KEY_ENV,
  makeGrokAuth,
  withGrokAuthPresentation,
} from "./auth.ts";
import { discoverGrokSkills } from "./skills.ts";
import {
  homebrewOwnershipFromCommandPath,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveHomebrewProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@goat/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@goat/provider-core/server/snapshotSettings";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const DRIVER_KIND = ProviderDriverKind.make("grok");
// npm latest matches the stable channel installed by grok update.
const GROK_NPM_PACKAGE = "@xai-official/grok";
// `grok update` installs under `GROK_HOME`; use the resolved executable and instance environment.
// Homebrew casks need brew upgrades; `grok update` would install a second copy.
// Keep casks manual when their brew cannot vouch for them.
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("resolveGrokMaintenance")(function* (context) {
    if (!context) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: GROK_NPM_PACKAGE,
      });
    }
    const homebrew = homebrewOwnershipFromCommandPath(context.realCommandPath);
    // Only a cask is Grok's: a formula keg such as `node` holding an npm global is not.
    if (homebrew?.kind === "cask") {
      return (
        (yield* resolveHomebrewProviderMaintenance(
          { provider: DRIVER_KIND, packageName: GROK_NPM_PACKAGE },
          homebrew,
          context,
        )) ??
        makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: GROK_NPM_PACKAGE,
          installPath: context.realCommandPath,
        })
      );
    }
    return makeProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: GROK_NPM_PACKAGE,
      updateExecutable: context.resolvedCommandPath,
      updateArgs: ["update"],
      updateLockKey: "grok",
      platform: context.platform,
      env: context.env,
    });
  }),
};

export type GrokDriverEnv =
  | GrokAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const GrokDriver: ProviderDriver<GrokSettings, GrokDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Grok",
    supportsMultipleInstances: true,
  },
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => decodeGrokSettings({}),
  usage: grokUsageReader,
  create: Effect.fn("GrokDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const { cwd } = host.paths;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const hasEnvironmentKey = Boolean(processEnv[GROK_API_KEY_ENV]?.trim());
    const snapshotReady = yield* Deferred.make<Effect.Effect<ServerProvider>>();
    const auth = yield* makeGrokAuth({
      instanceId,
      enabled,
      hasEnvironmentKey,
      onChanged: (expectAuthenticated) =>
        Effect.gen(function* () {
          const provider = yield* yield* Deferred.await(snapshotReady);
          if (expectAuthenticated && provider.auth.status !== "authenticated") {
            return yield* new ProviderSetupError({
              instanceId,
              operation: "start",
              detail: provider.message ?? "Could not verify the Grok sign-in. Try again.",
            });
          }
        }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to prepare Grok sign-in.",
            cause,
          }),
      ),
    );
    const presentSnapshot = (snapshot: ServerProvider, hasStoredKey: boolean) =>
      withGrokAuthPresentation(snapshot, {
        enabled,
        hasEnvironmentKey,
        hasStoredKey,
      });
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies GrokSettings;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
    const orchestrationAdapter = yield* GrokAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Grok orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeGrokTextGeneration(effectiveConfig, processEnv, {
      resolveEnvironment: auth.readStored.pipe(
        Effect.map((stored) => applyStoredGrokApiKey(processEnv, stored)),
      ),
      memoryRunnerContext: {
        providerInstanceId: instanceId,
        ...(host.environmentId === undefined ? {} : { environmentId: host.environmentId }),
      },
    });

    const checkProvider = auth.readStored.pipe(
      Effect.flatMap((stored) => {
        const environment = applyStoredGrokApiKey(processEnv, stored);
        return checkGrokProviderStatus(effectiveConfig, environment, cwd).pipe(
          Effect.flatMap((snapshot) =>
            effectiveConfig.enabled &&
            snapshot.installed &&
            snapshot.auth.status === "authenticated"
              ? readGrokAccount(environment).pipe(
                  Effect.map(({ email, usageLimits }) => ({
                    ...snapshot,
                    auth: email ? { ...snapshot.auth, email } : snapshot.auth,
                    usageLimits,
                  })),
                )
              : Effect.succeed(snapshot),
          ),
          Effect.map((snapshot) => presentSnapshot(stampIdentity(snapshot), stored !== undefined)),
        );
      }),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GrokSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        Effect.gen(function* () {
          const stored = yield* auth.readStored;
          return presentSnapshot(
            stampIdentity(yield* buildInitialGrokProviderSnapshot(settings.provider)),
            stored !== undefined,
          );
        }),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichGrokSnapshot({
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
            detail: "Failed to build Grok snapshot.",
            cause,
          }),
      ),
      Effect.tap((provider) => Deferred.succeed(snapshotReady, provider.refresh)),
    );
    const snapshotForCwd = (workspaceCwd: string) =>
      !effectiveConfig.enabled
        ? snapshot.getSnapshot
        : Effect.all([
            snapshot.getSnapshot,
            auth.readStored.pipe(
              Effect.flatMap((stored) =>
                discoverGrokSkills(
                  effectiveConfig,
                  applyStoredGrokApiKey(processEnv, stored),
                  workspaceCwd,
                ),
              ),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail: `Failed to discover Grok skills for '${workspaceCwd}'`,
                    cause,
                  }),
              ),
            ),
          ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })));

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      auth: auth.controller,
      snapshot,
      snapshotForCwd,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
