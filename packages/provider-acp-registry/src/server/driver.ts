import { resolveAcpCustomModels } from "../customModels.ts";
import { ProviderDriverKind, type ServerProvider, type ServerProviderModel } from "@goat/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { AcpRegistryAdapterV2Driver, type AcpRegistryAdapterV2DriverEnv } from "./adapter.ts";
import { makeAcpRegistryTextGeneration } from "./textGeneration.ts";
import { ProviderDriverError } from "@goat/provider-core/server/errors";
import { makeManagedServerProvider } from "@goat/provider-core/server/managedProvider";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@goat/provider-core/server/driver";
import { providerProbeEnvironment } from "@goat/provider-core/server/snapshotProbe";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@goat/provider-core/server/snapshotSettings";
import { type AcpRegistryLiveConfiguration, probeAcpRegistryConfiguration } from "./probe.ts";
import { makeAcpRegistrySessionManagement } from "./driverSessionManagement.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { probeFingerprint } from "./probeFingerprint.ts";
import {
  acpRegistryProbeTtlMs,
  isAcpRegistryCacheValid,
  PROBE_SUCCESS_TTL_MS,
  updateAcpRegistryEnrichmentCache as updateEnrichmentCache,
} from "./enrichmentCache.ts";
export { isAcpRegistryCacheValid } from "./enrichmentCache.ts";
import { applyAcpRegistryLiveConfiguration } from "./liveModelConfiguration.ts";
export { applyAcpRegistryLiveConfiguration } from "./liveModelConfiguration.ts";
import { makeAcpRegistryLearnedModels, type LearnedModelsCheck } from "./learnedModels.ts";
import {
  acpRegistryCurrentModelOptions,
  acpRegistryModelsToDiscover,
  makeAcpRegistryLearnedModelOptionsStore,
  withAcpRegistryLearnedModelOptions,
} from "./learnedModelOptions.ts";
import { environmentText, untilEnvironmentHolds } from "./environmentCheck.ts";
import {
  acpRegistryEnvironmentKey,
  acpRegistrySessionEnvironment,
} from "./sessionEnvironmentKey.ts";
import {
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryUrlAuthAction,
  buildInitialAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
} from "./driverSnapshots.ts";
export {
  applyAcpRegistryAvailableCommands,
  buildCheckedAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
} from "./driverSnapshots.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistryAuth from "./auth.ts";
import * as AcpRegistryAuthenticationState from "./authenticationState.ts";
import { makeMiniMaxCodeUsageEnrichment } from "./minimaxCodeUsageEnrichment.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const REGISTRY_REFRESH_FAILURE_BACKOFF_MS = 60 * 1_000;
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
export const updateAcpRegistryEnrichmentCache = (
  input: Parameters<typeof updateEnrichmentCache>[0],
) => updateEnrichmentCache(input, applyAcpRegistryLiveConfiguration);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type AcpRegistryDriverEnv =
  | AcpRegistryAdapterV2DriverEnv
  | Digest.Digest
  | ProviderHost.ProviderHost;

export const AcpRegistryDriver: ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ACP Registry",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: AcpRegistrySettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("AcpRegistryDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const runtimeCoordinator = yield* Effect.serviceOption(
      AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
    );
    if (Option.isSome(runtimeCoordinator)) {
      yield* runtimeCoordinator.value.clearAvailableCommands(instanceId);
      yield* runtimeCoordinator.value.clearLiveConfiguration(instanceId);
      yield* Effect.addFinalizer(() =>
        runtimeCoordinator.value
          .clearAvailableCommands(instanceId)
          .pipe(Effect.andThen(runtimeCoordinator.value.clearLiveConfiguration(instanceId))),
      );
    }
    const digest = yield* Digest.Digest;
    const random = yield* SecureRandom.SecureRandom;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostEnvironment = yield* HostProcess.Environment;
    const host = yield* ProviderHost.ProviderHost;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const identity = {
      instanceId,
      displayName,
      accentColor,
      continuationKey: continuationIdentity.continuationKey,
    };
    const effectiveConfig = { ...config, enabled } satisfies AcpRegistrySettings;
    const currentEnvironment = Effect.suspend(() =>
      mergeProviderInstanceEnvironment(environment, hostEnvironment),
    ).pipe(
      Effect.provideService(HostProcess.HomeDirectory, yield* HostProcess.HomeDirectory),
      Effect.map((env) => ({ ...env })),
    );
    const processEnvironment = yield* currentEnvironment;
    const orchestrationAdapter = yield* AcpRegistryAdapterV2Driver.create({
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
            detail: "Failed to build ACP Registry orchestration adapter.",
            cause,
          }),
      ),
    );
    const readinessInput = (environment: NodeJS.ProcessEnv) => ({
      ...identity,
      settings: effectiveConfig,
      environment,
    });
    const confirmedAuthentication =
      yield* AcpRegistryAuthenticationState.makeAcpRegistryAuthenticationState({
        cacheDir: host.paths.providerStatusCacheDir,
        instanceId,
        settings: effectiveConfig,
        environment,
        processEnvironment,
        currentEnvironment,
      });
    const learnedModels = yield* makeAcpRegistryLearnedModels((provider, configuration, previous) =>
      applyAcpRegistryLiveConfiguration(
        provider,
        configuration,
        resolveAcpCustomModels(effectiveConfig),
        previous,
      ),
    );
    // Refreshes rebuild the snapshot from the probe, so per-model options
    // reported by sessions and probe discovery are kept here and on disk.
    const learnedModelOptions = yield* makeAcpRegistryLearnedModelOptionsStore({
      cacheDir: host.paths.providerStatusCacheDir,
      instanceId,
      settings: effectiveConfig,
    });
    const envKeyFor = (env: NodeJS.ProcessEnv) =>
      acpRegistryEnvironmentKey(acpRegistrySessionEnvironment(effectiveConfig, env));
    const applyLiveConfiguration = Effect.fn("AcpRegistryDriver.applyLiveConfiguration")(function* (
      provider: ServerProvider,
      reported: AcpRegistryLiveConfiguration | undefined,
      environment: NodeJS.ProcessEnv,
      check: LearnedModelsCheck | undefined,
    ) {
      const envKey = envKeyFor(environment);
      const applied = yield* learnedModels.applyWithStatus(provider, reported, envKey, check);
      if (!applied.verified) return applied.provider;
      if (
        reported !== undefined &&
        (reported.environmentKey === undefined || reported.environmentKey === envKey)
      ) {
        const currentOptions = acpRegistryCurrentModelOptions(reported);
        if (currentOptions !== undefined) {
          yield* learnedModelOptions.learn(
            currentOptions.modelId,
            currentOptions.options,
            "live",
            envKey,
          );
        }
      }
      return withAcpRegistryLearnedModelOptions(
        applied.provider,
        yield* learnedModelOptions.get(envKey),
      );
    });
    // Tracks the latest live revision already applied so restarting enrichSnapshot skips replaying it.
    const lastObservedLiveRevision = yield* Ref.make(0);
    // Retains the last settled catalog per environment so readiness stays populated after a probe clears live state.
    const lastAcceptedCatalog = yield* Ref.make<{
      readonly envKey: string;
      readonly models: ReadonlyArray<ServerProviderModel>;
    } | null>(null);
    const observeLiveRevision = (revision: number) =>
      Ref.update(lastObservedLiveRevision, (current) => Math.max(current, revision));
    const isSyntheticDefaultOnly = (models: ReadonlyArray<ServerProviderModel>) => {
      const builtIn = models.filter((model) => !model.isCustom);
      return builtIn.length === 0 || (builtIn.length === 1 && builtIn[0]?.slug === "default");
    };
    const clearLearnedModels = learnedModels.clear.pipe(Effect.andThen(learnedModelOptions.clear));
    const hasRegistryAgent =
      effectiveConfig.enabled &&
      effectiveConfig.source !== "local" &&
      effectiveConfig.agentId.trim().length > 0;
    const clearLiveState = (
      Option.isSome(runtimeCoordinator)
        ? runtimeCoordinator.value
            .clearLiveConfiguration(instanceId)
            .pipe(Effect.andThen(runtimeCoordinator.value.clearAvailableCommands(instanceId)))
        : Effect.void
    ).pipe(Effect.andThen(clearLearnedModels), Effect.andThen(Ref.set(lastAcceptedCatalog, null)));
    const withLiveRuntimeState = Effect.fn("AcpRegistryDriver.withLiveRuntimeState")(function* (
      input: ServerProvider,
      environment: NodeJS.ProcessEnv,
      check: LearnedModelsCheck,
    ) {
      if (input.auth.status === "unauthenticated") {
        yield* confirmedAuthentication.set(false, environment);
        yield* Ref.set(lastAcceptedCatalog, null);
      }
      if (input.installed) yield* learnedModelOptions.setVersion(input.version);
      const envKey = envKeyFor(environment);
      const provider =
        input.enabled &&
        input.installed &&
        input.auth.status === "unknown" &&
        (yield* confirmedAuthentication.get)
          ? { ...input, auth: { ...input.auth, status: "authenticated" as const } }
          : input;
      const withAcceptedFallback = Effect.fnUntraced(function* (candidate: ServerProvider) {
        const learned = yield* learnedModelOptions.get(envKey);
        const accepted = yield* Ref.get(lastAcceptedCatalog);
        if (
          accepted !== null &&
          accepted.envKey === envKey &&
          candidate.enabled &&
          candidate.installed &&
          candidate.auth.status !== "unauthenticated" &&
          isSyntheticDefaultOnly(candidate.models)
        ) {
          const custom = candidate.models.filter((model) => model.isCustom);
          return withAcpRegistryLearnedModelOptions(
            { ...candidate, models: [...accepted.models, ...custom] },
            learned,
          );
        }
        return withAcpRegistryLearnedModelOptions(candidate, learned);
      });
      if (Option.isNone(runtimeCoordinator)) {
        return yield* withAcceptedFallback(provider);
      }
      const coordinator = runtimeCoordinator.value;
      const withCommands = applyAcpRegistryAvailableCommands(
        provider,
        yield* coordinator.getAvailableCommands(instanceId),
      );
      const liveSnapshot = yield* coordinator.getLiveConfigurationWithRevision(instanceId);
      yield* observeLiveRevision(liveSnapshot.revision);
      const base = yield* withAcceptedFallback(withCommands);
      const withConfiguration = yield* applyLiveConfiguration(
        base,
        Option.getOrUndefined(liveSnapshot.configuration),
        environment,
        check,
      );
      return applyAcpRegistryUrlAuthAction(
        withConfiguration,
        yield* coordinator.getUrlAuthAction(instanceId),
      );
    });
    const reportedLocalVersion = yield* Ref.make<{
      readonly key: string;
      readonly version: string;
    } | null>(null);
    // Readiness and the live state share one environment, read after the learned generation.
    const checkProvider = untilEnvironmentHolds(
      currentEnvironment,
      Effect.gen(function* () {
        const generation = yield* learnedModels.generation;
        const environment = yield* currentEnvironment;
        const provider = yield* checkAcpRegistryProviderReadiness(readinessInput(environment));
        const reported = yield* Ref.get(reportedLocalVersion);
        const key = envKeyFor(environment);
        const readyProvider =
          effectiveConfig.source === "local" &&
          provider.installed &&
          provider.version === null &&
          reported?.key === key
            ? { ...provider, version: reported.version }
            : provider;
        const result = yield* withLiveRuntimeState(readyProvider, environment, { generation });
        return { environment, result };
      }),
    ).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));
    const modelsToDiscover = Effect.fn("AcpRegistryDriver.modelsToDiscover")(function* (
      provider: ServerProvider,
      envKey: string,
    ) {
      yield* learnedModelOptions.setVersion(provider.version);
      const settings = yield* host.settings.get.pipe(Effect.option);
      // Without settings the hidden models are unknown, so nothing is opened.
      if (Option.isNone(settings)) return [];
      return acpRegistryModelsToDiscover({
        provider,
        settings: settings.value,
        learned: yield* learnedModelOptions.get(envKey),
      });
    });
    const enrichProvider = Effect.fn("AcpRegistryDriver.enrichProvider")(function* (
      environment: NodeJS.ProcessEnv,
      publishProbed: (
        provider: ServerProvider,
        modelsFromModelSelect: boolean,
      ) => Effect.Effect<void>,
    ) {
      const envKey = envKeyFor(environment);
      const modelsFromSelectRef = yield* Ref.make(false);
      const provider = yield* checkAcpRegistryProviderStatus(
        {
          ...readinessInput(environment),
          cwd: host.paths.cwd,
          modelDiscovery: {
            // Publish what the probe found first; discovery only adds options to it.
            onProbed: (provider) =>
              modelsToDiscover(provider, envKey).pipe(
                Effect.tap((modelIds) =>
                  modelIds.length === 0
                    ? Effect.void
                    : Ref.get(modelsFromSelectRef).pipe(
                        Effect.flatMap((fromSelect) => publishProbed(provider, fromSelect)),
                      ),
                ),
              ),
            onDiscovered: (configuration) => {
              const discovered = acpRegistryCurrentModelOptions(configuration);
              return discovered === undefined
                ? Effect.void
                : learnedModelOptions.learn(
                    discovered.modelId,
                    discovered.options,
                    "discovered",
                    envKey,
                  );
            },
          },
        },
        (input) =>
          probeAcpRegistryConfiguration(input).pipe(
            Effect.tap((result) =>
              Ref.set(modelsFromSelectRef, result.modelsFromModelSelect === true),
            ),
          ),
      ).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Digest.Digest, digest),
        Effect.provideService(SecureRandom.SecureRandom, random),
      );
      return { provider, modelsFromModelSelect: yield* Ref.get(modelsFromSelectRef) };
    });
    const enrichmentCache = yield* Ref.make<{
      readonly generation: number;
      readonly entry: {
        readonly provider: ServerProvider;
        readonly key: string;
        readonly environmentKey: string;
        readonly launchIdentity?: string;
        readonly expiresAt: number;
      } | null;
    }>({ generation: 0, entry: null });
    const liveSnapshotSemaphore = yield* Semaphore.make(1);
    const invalidateEnrichmentCache = Ref.update(enrichmentCache, (current) => ({
      generation: current.generation + 1,
      entry: null,
    }));
    interface EnrichedSnapshotPayload {
      readonly provider: ServerProvider;
      readonly generation: number;
      readonly learnedGeneration: number;
      readonly environment: NodeJS.ProcessEnv;
      readonly fresh: boolean;
      readonly probeStartLiveRevision: number;
      readonly modelsFromModelSelect: boolean;
      readonly runtimeChanged: boolean;
    }
    const enrichProviderCached = Effect.fn("AcpRegistryDriver.enrichProviderCached")(function* (
      baseSnapshot: ServerProvider,
      publish: (enriched: EnrichedSnapshotPayload) => Effect.Effect<void>,
    ) {
      if (hasRegistryAgent) {
        yield* catalog
          .refreshIndex({
            maxAgeMs: PROBE_SUCCESS_TTL_MS,
            failureBackoffMs: REGISTRY_REFRESH_FAILURE_BACKOFF_MS,
          })
          .pipe(Effect.ignore);
      }
      const learnedGeneration = yield* learnedModels.generation;
      const probeStartLiveRevision = Option.isSome(runtimeCoordinator)
        ? (yield* runtimeCoordinator.value.getLiveConfigurationWithRevision(instanceId)).revision
        : 0;
      const environment = yield* currentEnvironment;
      const currentInspection = hasRegistryAgent
        ? yield* catalog.inspect(effectiveConfig, environment).pipe(Effect.option)
        : Option.none();
      const inspectedVersion =
        Option.isSome(currentInspection) && currentInspection.value.status === "ready"
          ? currentInspection.value.version
          : baseSnapshot.version;
      const inspectedLaunchIdentity =
        Option.isSome(currentInspection) && currentInspection.value.status === "ready"
          ? currentInspection.value.launchIdentity
          : undefined;
      const now = yield* Clock.currentTimeMillis;
      const resolved = yield* Effect.result(
        catalog.resolve(effectiveConfig, host.paths.cwd, providerProbeEnvironment(environment), {
          allowInstall: false,
        }),
      );
      const key = Result.isFailure(resolved)
        ? null
        : yield* probeFingerprint(environment, resolved.success.spawn).pipe(
            Effect.provideService(Digest.Digest, digest),
            Effect.provideService(SecureRandom.SecureRandom, random),
          );
      const cacheState = yield* Ref.get(enrichmentCache);
      const cached = cacheState.entry;
      if (
        cached !== null &&
        key !== null &&
        cached.key === key &&
        isAcpRegistryCacheValid(
          cached,
          inspectedVersion,
          effectiveConfig.source === "local",
          now,
          inspectedLaunchIdentity,
        )
      ) {
        return {
          provider: { ...cached.provider, checkedAt: baseSnapshot.checkedAt },
          generation: cacheState.generation,
          learnedGeneration,
          environment,
          fresh: false,
          probeStartLiveRevision: 0,
          modelsFromModelSelect: false,
          runtimeChanged: false,
        };
      }
      const runtimeChanged =
        (cached !== null &&
          (cached.provider.version !== inspectedVersion ||
            (inspectedLaunchIdentity !== undefined &&
              cached.launchIdentity !== inspectedLaunchIdentity))) ||
        (inspectedVersion !== null &&
          baseSnapshot.version !== null &&
          inspectedVersion !== baseSnapshot.version);
      const remember = Effect.fn("AcpRegistryDriver.rememberEnrichment")(function* (
        enriched: ServerProvider,
      ) {
        if (enriched.status === "ready" && key !== null) {
          const completedAt = yield* Clock.currentTimeMillis;
          yield* Ref.update(enrichmentCache, (current) =>
            current.generation === cacheState.generation
              ? {
                  ...current,
                  entry: {
                    provider: enriched,
                    key,
                    environmentKey: envKeyFor(environment),
                    ...(inspectedLaunchIdentity === undefined
                      ? {}
                      : { launchIdentity: inspectedLaunchIdentity }),
                    expiresAt: completedAt + acpRegistryProbeTtlMs(enriched),
                  },
                }
              : current,
          );
        }
      });
      const { provider: enriched, modelsFromModelSelect } = yield* enrichProvider(
        environment,
        (provider, fromSelect) =>
          remember(provider).pipe(
            Effect.andThen(
              publish({
                provider,
                generation: cacheState.generation,
                learnedGeneration,
                environment,
                fresh: true,
                probeStartLiveRevision,
                modelsFromModelSelect: fromSelect,
                runtimeChanged,
              }),
            ),
          ),
      );
      yield* remember(enriched);
      return {
        provider: enriched,
        generation: cacheState.generation,
        learnedGeneration,
        environment,
        fresh: true,
        probeStartLiveRevision,
        modelsFromModelSelect,
        runtimeChanged,
      };
    });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<
      ProviderSnapshotSettings<AcpRegistrySettings>
    >({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      // Inspection may fetch the registry when its disk cache is missing; creation must not wait on that.
      initialSnapshot: () =>
        buildInitialAcpRegistrySnapshot({ ...identity, settings: effectiveConfig }),
      checkProvider,
      ...(yield* makeMiniMaxCodeUsageEnrichment(effectiveConfig, environment, currentEnvironment)),
      enrichSnapshot: Effect.fn("enrichSnapshot")(function* ({
        snapshot,
        getSnapshot,
        publishSnapshot,
      }) {
        let targetSnapshot = snapshot;
        if (!targetSnapshot.installed) {
          if (!hasRegistryAgent) return;
          const refresh = catalog
            .refreshIndex({
              maxAgeMs: PROBE_SUCCESS_TTL_MS,
              failureBackoffMs: REGISTRY_REFRESH_FAILURE_BACKOFF_MS,
            })
            .pipe(Effect.orElseSucceed(() => false));
          const refreshed = yield* Option.isSome(runtimeCoordinator)
            ? runtimeCoordinator.value.runBackgroundProbe(effectiveConfig.agentId, refresh)
            : refresh.pipe(Effect.asSome);
          if (Option.isNone(refreshed)) return;
          targetSnapshot = yield* checkProvider;
          if (!targetSnapshot.installed) {
            if (refreshed.value) {
              yield* liveSnapshotSemaphore.withPermit(publishSnapshot(targetSnapshot));
            }
            return;
          }
          yield* liveSnapshotSemaphore.withPermit(publishSnapshot(targetSnapshot));
        }
        const publishEnriched = ({
          provider,
          generation,
          learnedGeneration,
          environment,
          fresh,
          probeStartLiveRevision,
          modelsFromModelSelect,
          runtimeChanged,
        }: EnrichedSnapshotPayload) =>
          liveSnapshotSemaphore.withPermit(
            Effect.gen(function* () {
              const matchesEnvironment = Effect.map(
                currentEnvironment,
                (current) => environmentText(current) === environmentText(environment),
              );
              const current = yield* Ref.get(enrichmentCache);
              if (current.generation !== generation || !(yield* matchesEnvironment)) return;
              const envKey = envKeyFor(environment);
              let effectiveLearnedGeneration = learnedGeneration;
              if (fresh && provider.status === "ready") {
                const probedBuiltIn = provider.models.filter((model) => !model.isCustom);
                const authoritativeProbe =
                  probedBuiltIn.length > 1 || (probedBuiltIn.length === 1 && modelsFromModelSelect);
                if (runtimeChanged || authoritativeProbe) {
                  const cleared = Option.isSome(runtimeCoordinator)
                    ? yield* runtimeCoordinator.value.clearLiveConfigurationIfRevision(
                        instanceId,
                        probeStartLiveRevision,
                      )
                    : true;
                  if (cleared) {
                    if (runtimeChanged) {
                      yield* clearLiveState;
                    } else {
                      yield* learnedModels.clear;
                    }
                    effectiveLearnedGeneration = yield* learnedModels.generation;
                    if (authoritativeProbe) {
                      yield* Ref.set(lastAcceptedCatalog, { envKey, models: probedBuiltIn });
                    }
                  }
                }
              }
              const enriched = yield* withLiveRuntimeState(provider, environment, {
                generation: effectiveLearnedGeneration,
              });
              if (yield* matchesEnvironment) {
                if (
                  effectiveConfig.source === "local" &&
                  enriched.version !== null &&
                  enriched.status === "ready"
                ) {
                  yield* Ref.set(reportedLocalVersion, {
                    key: envKey,
                    version: enriched.version,
                  });
                }
                yield* publishSnapshot(enriched);
              }
            }),
          );
        const enrichment = enrichProviderCached(targetSnapshot, publishEnriched);
        const publishEnrichment = (
          Option.isSome(runtimeCoordinator)
            ? runtimeCoordinator.value.runBackgroundProbe(
                effectiveConfig.source === "local"
                  ? `local:${instanceId}`
                  : effectiveConfig.agentId,
                enrichment,
              )
            : enrichment.pipe(Effect.asSome)
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: publishEnriched,
            }),
          ),
        );
        if (Option.isNone(runtimeCoordinator)) return yield* publishEnrichment;

        const publishLiveCommands = runtimeCoordinator.value.watchAvailableCommands(
          instanceId,
          ({ slashCommands, skills }) =>
            liveSnapshotSemaphore.withPermit(
              getSnapshot.pipe(
                Effect.flatMap((current) =>
                  publishSnapshot({
                    ...current,
                    slashCommands,
                    skills,
                  }),
                ),
              ),
            ),
        );
        const publishLiveConfiguration = Ref.get(lastObservedLiveRevision).pipe(
          Effect.flatMap((afterRevision) =>
            runtimeCoordinator.value.watchLiveConfiguration(
              instanceId,
              (configuration, revision) =>
                liveSnapshotSemaphore.withPermit(
                  Effect.gen(function* () {
                    const live =
                      yield* runtimeCoordinator.value.getLiveConfigurationWithRevision(instanceId);
                    // A fresh probe cleared this revision; replaying it would restore a stale catalog.
                    if (live.revision !== revision && Option.isNone(live.configuration)) return;
                    yield* observeLiveRevision(revision);
                    const current = yield* getSnapshot;
                    const environment = yield* currentEnvironment;
                    const updated = yield* applyLiveConfiguration(
                      current,
                      configuration,
                      environment,
                      undefined,
                    );
                    const envKey = envKeyFor(environment);
                    if (
                      configuration.environmentKey === undefined ||
                      configuration.environmentKey === envKey
                    ) {
                      if (configuration.models.length > 0) {
                        const builtIn = updated.models.filter((model) => !model.isCustom);
                        if (
                          builtIn.length > 1 ||
                          (builtIn.length === 1 && configuration.modelsFromModelSelect === true)
                        ) {
                          yield* Ref.set(lastAcceptedCatalog, { envKey, models: builtIn });
                        }
                      }
                      const now = yield* Clock.currentTimeMillis;
                      yield* Ref.update(enrichmentCache, (cache) => {
                        const nextCache = updateAcpRegistryEnrichmentCache({
                          cache,
                          configuration,
                          customModels: resolveAcpCustomModels(effectiveConfig),
                          environmentKey: envKey,
                          now,
                        });
                        return cache.entry === null || nextCache.entry === null
                          ? { generation: nextCache.generation, entry: null }
                          : {
                              generation: nextCache.generation,
                              entry: {
                                ...nextCache.entry,
                                key: cache.entry.key,
                                environmentKey: cache.entry.environmentKey,
                                ...(cache.entry.launchIdentity === undefined
                                  ? {}
                                  : { launchIdentity: cache.entry.launchIdentity }),
                              },
                            };
                      });
                    }
                    yield* publishSnapshot(updated);
                  }),
                ),
              { afterRevision },
            ),
          ),
        );
        const publishUrlAuthAction = runtimeCoordinator.value.watchUrlAuthAction(
          instanceId,
          (action) =>
            liveSnapshotSemaphore.withPermit(
              getSnapshot.pipe(
                Effect.flatMap((current) =>
                  publishSnapshot(
                    applyAcpRegistryUrlAuthAction(current, Option.fromNullishOr(action)),
                  ),
                ),
              ),
            ),
        );
        yield* Effect.all(
          [publishEnrichment, publishLiveCommands, publishLiveConfiguration, publishUrlAuthAction],
          {
            concurrency: "unbounded",
            discard: true,
          },
        );
      }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build the ACP Registry provider snapshot.",
            cause,
          }),
      ),
    );

    const invalidateProviderCatalog = liveSnapshotSemaphore.withPermit(
      (Option.isSome(runtimeCoordinator)
        ? runtimeCoordinator.value.clearLiveConfiguration(instanceId)
        : Effect.void
      ).pipe(
        Effect.andThen(Ref.set(lastAcceptedCatalog, null)),
        Effect.andThen(invalidateEnrichmentCache),
      ),
    );
    const controller = yield* AcpRegistryAuth.makeAcpRegistryAuth({
      instanceId,
      settings: effectiveConfig,
      cwd: host.paths.cwd,
      environment: processEnvironment,
      currentEnvironment,
      onChanged: (authenticated, environment) =>
        confirmedAuthentication
          .set(authenticated, environment)
          .pipe(
            Effect.andThen(authenticated ? Effect.void : clearLiveState),
            Effect.andThen(liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
            Effect.andThen(snapshot.refresh),
            Effect.asVoid,
          ),
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(SecureRandom.SecureRandom, random),
    );
    const auth = {
      ...controller,
      invalidate: (controller.invalidate ?? Effect.void).pipe(
        Effect.andThen(confirmedAuthentication.set(false)),
        Effect.andThen(clearLiveState),
        Effect.andThen(liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
        Effect.andThen(snapshot.refresh),
        Effect.asVoid,
      ),
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      auth,
      snapshot: {
        ...snapshot,
        refresh: snapshot.refresh.pipe(Effect.tap(() => controller.refreshMethods ?? Effect.void)),
      },
      invalidateCaches: liveSnapshotSemaphore
        .withPermit(
          (Option.isSome(runtimeCoordinator)
            ? runtimeCoordinator.value.clearLiveConfiguration(instanceId)
            : Effect.void
          ).pipe(
            Effect.andThen(clearLearnedModels),
            Effect.andThen(Ref.set(lastAcceptedCatalog, null)),
            Effect.andThen(invalidateEnrichmentCache),
          ),
        )
        .pipe(Effect.andThen(hasRegistryAgent ? catalog.invalidateIndex() : Effect.void)),
      orchestrationAdapter,
      textGeneration: yield* makeAcpRegistryTextGeneration({
        instanceId,
        settings: effectiveConfig,
        environment: processEnvironment,
      }),
      acpSessionManagement: makeAcpRegistrySessionManagement({
        instanceId,
        settings: effectiveConfig,
        currentEnvironment,
        catalog,
        spawner,
        digest,
        random,
        runtimeCoordinator,
        onProviderMutation: invalidateProviderCatalog,
        onLogout: (environment) => confirmedAuthentication.set(false, environment),
        onAfterLogout: liveSnapshotSemaphore.withPermit(
          invalidateEnrichmentCache.pipe(
            Effect.andThen(Ref.set(lastAcceptedCatalog, null)),
            Effect.andThen(clearLearnedModels),
            Effect.andThen(
              Option.isSome(runtimeCoordinator)
                ? Effect.all(
                    [
                      runtimeCoordinator.value.clearAvailableCommands(instanceId),
                      runtimeCoordinator.value.clearLiveConfiguration(instanceId),
                    ],
                    { concurrency: "unbounded", discard: true },
                  )
                : Effect.void,
            ),
          ),
        ),
      }),
    } satisfies ProviderInstance;
  }),
};
