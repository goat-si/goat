import { CommandResolutionCache, resolveCommandPath } from "@goat/shared/shell";
import { ProviderDriverKind, ProviderSetupError, type ServerProvider } from "@goat/contracts";
import { GrokSettings } from "../settings.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
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
// npm 12 blocks the postinstall that moves the new binary in, yet exits 0, so allow it by env.
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
      env: { ...context.env, npm_config_allow_scripts: GROK_NPM_PACKAGE },
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
    const hostEnvironment = yield* HostProcess.Environment;
    const currentEnvironment = Effect.suspend(() =>
      mergeProviderInstanceEnvironment(environment, hostEnvironment),
    ).pipe(Effect.provideService(HostProcess.HomeDirectory, yield* HostProcess.HomeDirectory));
    const processEnv = { ...(yield* currentEnvironment) };
    const snapshotReady = yield* Deferred.make<Effect.Effect<ServerProvider>>();
    const auth = yield* makeGrokAuth({
      instanceId,
      enabled,
      currentEnvironment,
      verifyKey: (key) =>
        httpClient
          .execute(
            HttpClientRequest.get("https://api.x.ai/v1/models").pipe(
              HttpClientRequest.bearerToken(key),
            ),
          )
          .pipe(
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? Effect.void
                : Effect.fail(
                    new ProviderSetupError({
                      instanceId,
                      operation: "start",
                      detail: "Could not verify the Grok API key. Try again.",
                    }),
                  ),
            ),
            Effect.mapError(
              () =>
                new ProviderSetupError({
                  instanceId,
                  operation: "start",
                  detail: "Could not verify the Grok API key. Try again.",
                }),
            ),
          ),
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
    const presentSnapshot = (
      snapshot: ServerProvider,
      hasStoredKey: boolean,
      hasEnvironmentKey: boolean,
    ) =>
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
    const maintenanceForEnvironment = (env: NodeJS.ProcessEnv) =>
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      currentEnvironment.pipe(Effect.flatMap(maintenanceForEnvironment)),
      {
        lookup: currentEnvironment.pipe(
          Effect.flatMap((env) =>
            Effect.gen(function* () {
              const resolved = effectiveConfig.binaryPath
                ? yield* resolveCommandPath(effectiveConfig.binaryPath, { env }).pipe(
                    Effect.provideService(CommandResolutionCache, new Map()),
                  )
                : undefined;
              const real = resolved
                ? yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => null))
                : null;
              // The link target, so an upgrade that retargets the same path is a new install.
              return { env, resolvedCommandPath: resolved ?? null, install: real };
            }),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
        resolve: ({ env }) => maintenanceForEnvironment(env),
      },
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
        Effect.flatMap((stored) =>
          currentEnvironment.pipe(Effect.map((env) => applyStoredGrokApiKey(env, stored))),
        ),
      ),
      memoryRunnerContext: {
        providerInstanceId: instanceId,
        ...(host.environmentId === undefined ? {} : { environmentId: host.environmentId }),
      },
    });

    const checkProvider = auth.readStored.pipe(
      Effect.flatMap((stored) =>
        currentEnvironment.pipe(
          Effect.flatMap((env) => {
            const environment = applyStoredGrokApiKey(env, stored);
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
              Effect.map((snapshot) =>
                presentSnapshot(
                  stampIdentity(snapshot),
                  stored !== undefined,
                  Boolean(env[GROK_API_KEY_ENV]?.trim()),
                ),
              ),
            );
          }),
        ),
      ),
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
          const env = yield* currentEnvironment;
          return presentSnapshot(
            stampIdentity(yield* buildInitialGrokProviderSnapshot(settings.provider)),
            stored !== undefined,
            Boolean(env[GROK_API_KEY_ENV]?.trim()),
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
                currentEnvironment.pipe(
                  Effect.flatMap((env) =>
                    discoverGrokSkills(
                      effectiveConfig,
                      applyStoredGrokApiKey(env, stored),
                      workspaceCwd,
                    ),
                  ),
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
