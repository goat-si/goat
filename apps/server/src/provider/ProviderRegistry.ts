import { makeProviderWorkspaceRescanQueue } from "./ProviderWorkspaceRescanQueue.ts";
import { correlateSnapshotWithSource } from "./ProviderSnapshotCorrelation.ts";
import { ProviderRegistry } from "./ProviderRegistryService.ts";
export { ProviderRegistry } from "./ProviderRegistryService.ts";
export type { ProviderMaintenanceActionKind } from "./ProviderRegistryService.ts";
import { loadBootProviderSnapshots } from "./ProviderRegistryBoot.ts";
import {
  invalidateChangedWorkspaceCatalog,
  mergeProviderSnapshot,
  sameWorkspaceCatalogBasis,
} from "./ProviderSnapshotMerge.ts";
import * as GlobalSkillRegistry from "../skills/GlobalSkillsRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  defaultInstanceIdForDriver,
  isProviderWorkspaceSnapshotCurrent,
  isProviderWorkspaceSnapshotPending,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as ModelManifest from "./ModelManifest.ts";
import {
  dropProviderWorkspaceSnapshot,
  upsertProviderWorkspaceSnapshot,
} from "./ProviderWorkspaceSnapshots.ts";
export { upsertProviderWorkspaceSnapshot } from "./ProviderWorkspaceSnapshots.ts";
import { makeModelCatalogRefresh } from "./ModelCatalogRefresh.ts";
import { applyProviderCompatibility } from "./providerCompatibility.ts";
import {
  applyProviderMemoryRevocation,
  applyProviderMemoryRevocations,
  readProviderGenerationSnapshot,
  streamProviderGenerationSnapshots,
} from "./providerGenerationSnapshot.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import { makeProviderSnapshotWatchers } from "./ProviderSnapshotWatchers.ts";
import {
  orderProviderSnapshots,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  latestProviderVersionCacheKeys,
} from "@goat/provider-core/server/maintenanceResolver";
import type { ProviderSnapshotSource } from "./builtInProviderCatalog.ts";

const loadProviders = (
  providerSources: ReadonlyArray<ProviderSnapshotSource>,
): Effect.Effect<ReadonlyArray<ServerProvider>> =>
  Effect.forEach(
    providerSources,
    (providerSource) =>
      providerSource.getSnapshot.pipe(
        Effect.flatMap((snapshot) => correlateSnapshotWithSource(providerSource, snapshot)),
      ),
    {
      concurrency: "unbounded",
    },
  );

const makeManualProviderMaintenanceCapabilities = (provider: ProviderDriverKind) =>
  makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });

const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

const snapshotInstanceKey = (provider: ServerProvider): ProviderInstanceId => {
  return provider.instanceId;
};

// Rebuilt instances have new PubSubs; capture their fresh closures instead of a closed source.
const buildSnapshotSource = (instance: ProviderInstance): ProviderSnapshotSource => ({
  instanceId: instance.instanceId,
  driverKind: instance.driverKind,
  getSnapshot: readProviderGenerationSnapshot(instance),
  refresh: instance.snapshot.refresh,
  streamChanges: streamProviderGenerationSnapshots(instance),
});

export { mergeProviderSnapshot };

const PROVIDER_SNAPSHOT_WATCH_CONCURRENCY = 2;

export const layer = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const manifestService = yield* ModelManifest.ModelManifest;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const serviceScope = yield* Effect.scope;
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const globalSkills = GlobalSkillRegistry.makeGlobalSkillInventory(
      config.globalSkillsDir,
      settings,
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    const bootInstances = yield* instanceRegistry.listInstances;
    const bootSources = bootInstances.map(buildSnapshotSource);
    const fallbackProviders = yield* loadProviders(bootSources);
    const { bootProviders, awaitingBootInstances } = yield* loadBootProviderSnapshots({
      bootInstances,
      bootSources,
      fallbackProviders,
      cacheDir: config.providerStatusCacheDir,
      fileSystem,
      path,
    });
    const initialManifest = yield* manifestService.current;
    const classifyCompatibility = (
      provider: ServerProvider,
      manifest: ModelManifest.ModelManifestData,
    ) =>
      applyProviderCompatibility(
        provider,
        manifest.compatibility,
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
      );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      bootProviders.map((provider) => classifyCompatibility(provider, initialManifest)),
    );
    const workspaceRefreshesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstance, ReadonlyMap<string, Deferred.Deferred<void>>>
    >(new Map());
    const maintenanceActionStatesRef = yield* Ref.make<
      ReadonlyMap<
        ProviderInstanceId,
        { readonly update?: ServerProviderUpdateState; readonly targetVersion?: string | undefined }
      >
    >(new Map());

    const liveSubsRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ProviderInstance>>(
      new Map(),
    );
    const getProviders = Ref.get(providersRef).pipe(
      Effect.map((providers) =>
        applyProviderMemoryRevocations(providers, Ref.getUnsafe(liveSubsRef)),
      ),
    );
    const rescanQueue = yield* makeProviderWorkspaceRescanQueue;
    const syncSemaphore = yield* Semaphore.make(1);
    const watchers = makeProviderSnapshotWatchers(serviceScope);
    const isCurrentInstance = (instance: ProviderInstance) =>
      instanceRegistry
        .getInstance(instance.instanceId)
        .pipe(Effect.map((current) => current === instance));

    const persistProvider = Effect.fn("ProviderRegistry.persistProvider")(function* (
      provider: ServerProvider,
    ) {
      if (provider.awaitingFirstCheck) return;
      const key = snapshotInstanceKey(provider);
      const filePath = yield* resolveProviderStatusCachePath({
        cacheDir: config.providerStatusCacheDir,
        instanceId: key,
      }).pipe(Effect.provideService(Path.Path, path));
      const {
        workspaceSnapshots: _workspaceSnapshots,
        workspaceRescannedAt: _workspaceRescannedAt,
        memoryGeneration: _memoryGeneration,
        ...machineProvider
      } = provider;
      yield* writeProviderStatusCache({ filePath, provider: machineProvider }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.tapError(Effect.logError),
        Effect.ignore,
      );
    });

    const applyProviderUpdateState = Effect.fn("applyProviderUpdateState")(function* (
      provider: ServerProvider,
    ) {
      const maintenanceActionStates = yield* Ref.get(maintenanceActionStatesRef);
      const updateState = maintenanceActionStates.get(provider.instanceId)?.update;
      if (!updateState) {
        const { updateState: _updateState, ...providerWithoutUpdateState } = provider;
        return providerWithoutUpdateState;
      }
      return {
        ...provider,
        updateState,
      };
    });

    const upsertProviders = Effect.fn("upsertProviders")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly publish?: boolean;
        readonly persist?: boolean;
        readonly replace?: boolean;
        readonly instance?: ProviderInstance;
      },
    ) {
      const manifest = yield* manifestService.current;
      const globals = yield* globalSkills.scan;
      const nextProvidersWithUpdateState = yield* Effect.forEach(
        nextProviders,
        applyProviderUpdateState,
        {
          concurrency: "unbounded",
        },
      );
      const commit = Ref.modify(providersRef, (previousProviders) => {
        const previousByKey = new Map(
          previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
        );
        const mergedProviders = new Map(previousByKey);
        const updatedKeys = new Set<ProviderInstanceId>();

        const instances = Ref.getUnsafe(liveSubsRef);
        for (const snapshot of nextProvidersWithUpdateState) {
          const key = snapshotInstanceKey(snapshot);
          // The capability may have been revoked while this snapshot was being published.
          const provider = applyProviderMemoryRevocation(snapshot, instances.get(key));
          updatedKeys.add(key);
          mergedProviders.set(
            key,
            options?.replace === true
              ? provider
              : mergeProviderSnapshot(mergedProviders.get(key), provider),
          );
        }

        const providers = orderProviderSnapshots(
          [...mergedProviders.values()].map((provider) =>
            invalidateChangedWorkspaceCatalog(
              previousByKey.get(snapshotInstanceKey(provider)),
              GlobalSkillRegistry.mergeGlobalSkills(
                classifyCompatibility(provider, manifest),
                globals,
              ),
            ),
          ),
        );
        const providersToPersist = providers.filter((provider) =>
          updatedKeys.has(snapshotInstanceKey(provider)),
        );
        return [[previousProviders, providers, providersToPersist] as const, providers];
      });
      const committed = yield* options?.instance === undefined
        ? commit
        : isCurrentInstance(options.instance).pipe(
            Effect.flatMap((current) => (current ? commit : Effect.undefined)),
            Effect.provideService(Scheduler.PreventSchedulerYield, true),
          );
      if (committed === undefined) return yield* getProviders;
      const [previousProviders, providers, providersToPersist] = committed;

      if (haveProvidersChanged(previousProviders, providers)) {
        if (options?.persist !== false) {
          yield* Effect.forEach(providersToPersist, persistProvider, {
            concurrency: "unbounded",
            discard: true,
          });
        }
        if (options?.publish !== false) {
          // A newer upsert may have committed and published during the cache write; never republish an older array.
          yield* PubSub.publish(changesPubSub, yield* getProviders);
        }
      }

      return yield* getProviders;
    });

    // Assigned after refreshInstance is built; breaks the snapshot/refresh
    // inference cycle while keeping auth-triggered refreshes in one place.
    let refreshAuthDependents: GlobalSkillRegistry.RefreshDependentAuth = () => Effect.void;
    const compatibilityRefreshRunning = yield* Ref.make(false);
    const refreshCompatibility = Effect.gen(function* () {
      if (!(yield* Ref.getAndSet(compatibilityRefreshRunning, true))) {
        yield* manifestService.refresh.pipe(
          Effect.andThen(upsertProviders([], { persist: false })),
          Effect.ensuring(Ref.set(compatibilityRefreshRunning, false)),
          Effect.forkIn(serviceScope),
        );
      }
    });
    const syncProvider = Effect.fn("syncProvider")(function* (
      instance: ProviderInstance,
      provider: ServerProvider,
    ) {
      if (!(yield* isCurrentInstance(instance))) return yield* getProviders;
      const previous = (yield* Ref.get(providersRef)).find(
        (candidate) => candidate.instanceId === provider.instanceId,
      );
      // Latest-version status cannot resolve a failed recommended-version install.
      if (provider.versionAdvisory?.status === "current") {
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const action = previous.get(provider.instanceId);
          if (
            action?.targetVersion !== undefined ||
            (action?.update?.status !== "unchanged" && action?.update?.status !== "failed")
          ) {
            return previous;
          }
          const next = new Map(previous);
          next.delete(provider.instanceId);
          return next;
        });
      }
      const providers = yield* upsertProviders([provider], { instance });
      if (!(yield* isCurrentInstance(instance))) return yield* getProviders;
      yield* GlobalSkillRegistry.refreshDependentAuth(
        previous,
        provider,
        providers,
        refreshAuthDependents,
        serviceScope,
      );
      yield* refreshCompatibility;
      return yield* getProviders;
    });

    const setProviderMaintenanceActionState = Effect.fn("setProviderMaintenanceActionState")(
      function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly action: "update";
        readonly state: ServerProviderUpdateState | null;
        readonly targetVersion?: string | undefined;
      }) {
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const next = new Map(previous);
          if (input.state === null || input.state.status === "idle") {
            next.delete(input.instanceId);
          } else {
            next.set(input.instanceId, { update: input.state, targetVersion: input.targetVersion });
          }
          return next;
        });

        const existingProviders = yield* getProviders;
        const matchingProvider = existingProviders.find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        if (!matchingProvider) {
          return existingProviders;
        }

        const nextProvider = yield* applyProviderUpdateState(matchingProvider);
        return yield* upsertProviders([nextProvider], {
          persist: false,
        });
      },
    );

    const refreshOneSource = Effect.fn("refreshOneSource")(function* (instance: ProviderInstance) {
      const source = buildSnapshotSource(instance);
      const probe = yield* source.refresh.pipe(Effect.andThen(source.getSnapshot), Effect.exit);
      if (!(yield* isCurrentInstance(instance))) return yield* getProviders;
      const snapshot = yield* probe;
      return yield* correlateSnapshotWithSource(source, snapshot).pipe(
        Effect.flatMap((provider) => syncProvider(instance, provider)),
      );
    });

    const catalogRefresh = yield* makeModelCatalogRefresh(
      manifestService,
      latestVersions,
      initialManifest,
    );
    type RefreshAllCompletion = Deferred.Deferred<ReadonlyArray<ServerProvider>>;
    const refreshAllInFlightRef = yield* Ref.make<Option.Option<RefreshAllCompletion>>(
      Option.none(),
    );

    const refreshAll = Effect.fn("refreshAll")(function* () {
      const claimed = yield* Ref.modify(
        refreshAllInFlightRef,
        (
          inFlight,
        ): readonly [
          { readonly owner: boolean; readonly completion: RefreshAllCompletion },
          Option.Option<RefreshAllCompletion>,
        ] => {
          if (Option.isSome(inFlight)) {
            return [{ owner: false, completion: inFlight.value }, inFlight];
          }
          const completion = Deferred.makeUnsafe<ReadonlyArray<ServerProvider>>();
          return [{ owner: true, completion }, Option.some(completion)];
        },
      );
      if (claimed.owner) {
        // Detach shared passes so the first caller's interruption cannot cancel other callers' work.
        yield* catalogRefresh
          .capture(
            syncLiveSourcesAndContinue.pipe(
              Effect.andThen(Ref.get(liveSubsRef)),
              Effect.flatMap((instances) =>
                Effect.forEach(instances.values(), (instance) => refreshOneSource(instance), {
                  concurrency: "unbounded",
                  discard: true,
                }),
              ),
              Effect.andThen(getProviders),
            ),
          )
          .pipe(
            Effect.onExit((exit) =>
              Ref.set(refreshAllInFlightRef, Option.none()).pipe(
                Effect.andThen(Deferred.done(claimed.completion, exit)),
              ),
            ),
            Effect.forkDetach,
          );
      }
      return yield* Deferred.await(claimed.completion);
    });

    const awaitInFlightRefresh = Ref.get(refreshAllInFlightRef).pipe(
      Effect.flatMap((inFlight) =>
        Option.isSome(inFlight) ? Effect.exit(Deferred.await(inFlight.value)) : Effect.void,
      ),
      Effect.asVoid,
    );

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderDriverKind) {
      if (provider === undefined) {
        return yield* refreshAll();
      }
      yield* syncLiveSourcesAndContinue;
      const instance = (yield* Ref.get(liveSubsRef)).get(defaultInstanceIdForDriver(provider));
      return yield* instance ? refreshOneSource(instance) : getProviders;
    });

    const refreshInstance = Effect.fn("refreshInstance")(function* (
      instanceId: ProviderInstanceId,
    ) {
      yield* syncLiveSourcesAndContinue;
      const instance = (yield* Ref.get(liveSubsRef)).get(instanceId);
      return yield* instance ? refreshOneSource(instance) : getProviders;
    });
    refreshAuthDependents = GlobalSkillRegistry.makeRefreshAuthDependents(refreshInstance);

    const refreshAfterUpdate = Effect.fn("refreshAfterUpdate")(function* (
      provider: ProviderDriverKind,
      selectedInstanceId: ProviderInstanceId,
    ) {
      yield* manifestService.forceRefresh;
      const instances = (yield* instanceRegistry.listInstances).filter(
        (instance) =>
          instance.driverKind === provider &&
          (instance.enabled || instance.instanceId === selectedInstanceId),
      );
      const failedInstances = new Set<ProviderInstanceId>();
      const recoverInstanceFailure = Effect.fn("recoverPostUpdateRefreshFailure")(function* (
        instanceId: ProviderInstanceId,
        cause: Cause.Cause<unknown>,
      ) {
        if (Cause.hasInterruptsOnly(cause)) {
          return yield* Effect.interrupt;
        }
        yield* Effect.logError("provider post-update refresh failed", {
          instanceId,
          cause: Cause.pretty(cause),
        });
        failedInstances.add(instanceId);
        // A cached ready snapshot cannot verify a successful update.
        return yield* updateProviders((providers) =>
          providers.map((candidate) =>
            candidate.instanceId === instanceId
              ? { ...candidate, status: "error", message: "Provider refresh failed after update." }
              : candidate,
          ),
        );
      });
      // Instances can share the replaced service, so none may invalidate before it restarts.
      const selectedInstance = instances.find(
        (instance) => instance.instanceId === selectedInstanceId,
      );
      if (selectedInstance?.afterUpdate !== undefined) {
        // The probe below reports what is running, so a failed hook needs no status of its own.
        yield* selectedInstance.afterUpdate.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logError("provider post-update hook failed", {
                  instanceId: selectedInstance.instanceId,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
      }
      // Accounts can share an installation, but discovery must use each
      // instance's own executable, environment, and credentials.
      yield* Effect.forEach(
        instances,
        (instance) =>
          Effect.gen(function* () {
            yield* instance.invalidateCaches ?? Effect.void;
            const maintenance = yield* instance.snapshot.resolveMaintenance({ fresh: true });
            yield* Effect.forEach(
              latestProviderVersionCacheKeys(maintenance),
              latestVersions.invalidate,
              { discard: true },
            );
          }).pipe(Effect.catchCause((cause) => recoverInstanceFailure(instance.instanceId, cause))),
        { concurrency: "unbounded", discard: true },
      );
      yield* Effect.forEach(
        instances.filter((instance) => !failedInstances.has(instance.instanceId)),
        (instance) =>
          refreshOneSource(instance).pipe(
            Effect.catchCause((cause) => recoverInstanceFailure(instance.instanceId, cause)),
          ),
        { concurrency: "unbounded", discard: true },
      );
      const refreshedInstances = yield* Effect.filter(
        instances.filter((instance) => !failedInstances.has(instance.instanceId)),
        isCurrentInstance,
      );
      const refreshedInstanceIds = new Set(
        refreshedInstances.map((instance) => instance.instanceId),
      );
      return (yield* getProviders).filter((candidate) =>
        refreshedInstanceIds.has(candidate.instanceId),
      );
    });

    const getProviderMaintenanceCapabilitiesForInstance = Effect.fn(
      "getProviderMaintenanceCapabilitiesForInstance",
    )(function* (
      instanceId: ProviderInstanceId,
      provider: ProviderDriverKind,
      options?: { readonly fresh?: boolean },
    ) {
      // liveSubsRef trails reconciliation and could run a retired instance's command; read the registry.
      const instance = yield* instanceRegistry.getInstance(instanceId);
      if (!instance || instance.driverKind !== provider) {
        return makeManualProviderMaintenanceCapabilities(provider);
      }
      return yield* instance.snapshot.resolveMaintenance(options);
    });

    const syncLiveSources = syncSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const instances = yield* instanceRegistry.listInstances;
        const unavailableProviders = yield* instanceRegistry.listUnavailable;
        const nextByInstance = new Map<ProviderInstanceId, ProviderInstance>(
          instances.map((instance) => [instance.instanceId, instance] as const),
        );
        const knownInstanceIds = new Set<ProviderInstanceId>(nextByInstance.keys());
        for (const provider of unavailableProviders) {
          knownInstanceIds.add(snapshotInstanceKey(provider));
        }
        const previousSubs = yield* Ref.get(liveSubsRef);
        yield* watchers.retire(nextByInstance);
        const newlyAdded = instances.filter(
          (instance) => previousSubs.get(instance.instanceId) !== instance,
        );

        const rebuiltInstanceIds = new Set(
          newlyAdded
            .map((instance) => instance.instanceId)
            .filter((instanceId) => previousSubs.has(instanceId)),
        );
        if (rebuiltInstanceIds.size > 0) {
          const [previousProviders, providers] = yield* Ref.modify(
            providersRef,
            (previousProviders) => {
              const providers = previousProviders.map((provider) => {
                if (!rebuiltInstanceIds.has(provider.instanceId)) return provider;
                const {
                  workspaceSnapshots: _workspaceSnapshots,
                  workspaceRescannedAt: _workspaceRescannedAt,
                  ...machineSnapshot
                } = provider;
                return machineSnapshot;
              });
              return [[previousProviders, providers] as const, providers];
            },
          );
          if (haveProvidersChanged(previousProviders, providers)) {
            yield* PubSub.publish(changesPubSub, providers);
          }
        }

        // Subscribe before reading so a probe completing mid-sync is observed by at least one path.
        for (const instance of newlyAdded) {
          const source = buildSnapshotSource(instance);
          yield* watchers.start(
            instance,
            Effect.all(
              [
                Stream.runForEach(source.streamChanges, (provider) =>
                  correlateSnapshotWithSource(source, provider).pipe(
                    Effect.flatMap((snapshot) => syncProvider(instance, snapshot)),
                  ),
                ),
                instance.workspaceRescans === undefined
                  ? Effect.void
                  : Stream.runForEach(instance.workspaceRescans, (cwd) =>
                      rescanQueue.offer(instance, cwd),
                    ),
              ],
              { concurrency: PROVIDER_SNAPSHOT_WATCH_CONCURRENCY, discard: true },
            ),
          );
        }
        yield* Effect.yieldNow;

        yield* Effect.forEach(
          newlyAdded,
          (instance) =>
            Effect.gen(function* () {
              const source = buildSnapshotSource(instance);
              const provider = yield* source.getSnapshot;
              // Boot shows the cached status until this instance's first check publishes a result.
              if (
                awaitingBootInstances.has(instance) &&
                (yield* instance.snapshot.isAwaitingFirstCheck ?? Effect.succeed(false))
              ) {
                return yield* refreshCompatibility;
              }
              yield* correlateSnapshotWithSource(source, provider).pipe(
                Effect.flatMap((snapshot) => syncProvider(instance, snapshot)),
              );
            }).pipe(Effect.ignoreCause({ log: true })),
          { concurrency: "unbounded", discard: true },
        );
        yield* upsertProviders(unavailableProviders, {
          persist: false,
          replace: true,
        });

        yield* Ref.set(liveSubsRef, nextByInstance);

        const [previousProviders, providers] = yield* Ref.modify(
          providersRef,
          (previousProviders) => {
            const providers = orderProviderSnapshots(
              previousProviders.filter((provider) =>
                knownInstanceIds.has(snapshotInstanceKey(provider)),
              ),
            );
            return [[previousProviders, providers] as const, providers];
          },
        );
        if (haveProvidersChanged(previousProviders, providers)) {
          yield* PubSub.publish(changesPubSub, providers);
        }
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const next = new Map(previous);
          for (const instanceId of previous.keys()) {
            if (!knownInstanceIds.has(instanceId)) {
              next.delete(instanceId);
            }
          }
          return next;
        });
      }),
    );
    const syncLiveSourcesAndContinue = syncLiveSources.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logError(
          "provider registry instance sync failed; keeping subscription alive",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
      Scope.provide(serviceScope),
    );

    yield* upsertProviders(
      fallbackProviders.filter((_, index) => {
        const instance = bootInstances[index];
        return instance === undefined || !awaitingBootInstances.has(instance);
      }),
      { publish: false },
    );
    const instanceChanges = yield* instanceRegistry.subscribeChanges;
    yield* syncLiveSources;
    yield* Stream.runForEach(
      Stream.fromSubscription(instanceChanges),
      () => syncLiveSourcesAndContinue,
    ).pipe(Effect.forkScoped);

    const recoverRefreshFailure = Effect.fn("recoverRefreshFailure")(function* (
      cause: Cause.Cause<unknown>,
    ) {
      if (Cause.hasInterruptsOnly(cause)) {
        return yield* Effect.interrupt;
      }
      yield* Effect.logError("provider registry refresh failed; preserving cached providers", {
        cause: Cause.pretty(cause),
      });
      return yield* getProviders;
    });

    const updateProviders = (
      update: (providers: ReadonlyArray<ServerProvider>) => ReadonlyArray<ServerProvider>,
    ) =>
      Ref.modify(providersRef, (currentProviders) => {
        const nextProviders = update(currentProviders);
        return [[currentProviders, nextProviders] as const, nextProviders];
      }).pipe(
        Effect.tap(([previousProviders, nextProviders]) =>
          haveProvidersChanged(previousProviders, nextProviders)
            ? PubSub.publish(changesPubSub, nextProviders)
            : Effect.void,
        ),
        Effect.andThen(getProviders),
      );

    const rescanGlobalSkills = globalSkills.rescan(updateProviders);
    yield* globalSkills.watch(rescanGlobalSkills);

    const refreshWorkspaceSnapshot = Effect.fn("refreshWorkspaceSnapshot")(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly cwd: string;
      readonly scanCwd?: string;
      readonly fresh?: boolean;
      readonly rescan?: ProviderInstance;
    }) {
      const before =
        input.rescan === undefined
          ? undefined
          : (yield* getProviders)
              .find((candidate) => candidate.instanceId === input.instanceId)
              ?.workspaceSnapshots?.find((snapshot) => snapshot.cwd === input.cwd);
      const running =
        input.rescan === undefined
          ? undefined
          : (yield* Ref.get(workspaceRefreshesRef)).get(input.rescan)?.get(input.cwd);
      if (running !== undefined) yield* Deferred.await(running);
      if (input.fresh) {
        yield* updateProviders((providers) =>
          providers.map((candidate) =>
            candidate.instanceId === input.instanceId
              ? candidate
              : dropProviderWorkspaceSnapshot(candidate, input.cwd),
          ),
        );
      }
      const providers = yield* getProviders;
      const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
      const workspaceSnapshotOf = (candidate: ServerProvider | undefined) =>
        candidate?.workspaceSnapshots?.find((s) => s.cwd === input.cwd);
      const scannedFrom = workspaceSnapshotOf(provider);
      const now = yield* DateTime.now;
      if (
        !provider ||
        !provider.enabled ||
        (!input.fresh &&
          input.rescan === undefined &&
          scannedFrom &&
          !isProviderWorkspaceSnapshotPending(scannedFrom) &&
          isProviderWorkspaceSnapshotCurrent(scannedFrom, DateTime.toEpochMillis(now)))
      ) {
        return providers;
      }
      // Use scan start for TTL, not checkedAt inherited from the machine health check.
      const scannedAt = DateTime.formatIso(now);
      const instance = yield* instanceRegistry.getInstance(input.instanceId);
      const snapshotForCwd = instance?.snapshotForCwd;
      if (!instance || !snapshotForCwd) return providers;
      if (
        input.rescan !== undefined &&
        (input.rescan !== instance || (running === undefined && scannedFrom === undefined))
      )
        return providers;
      const token = yield* Deferred.make<void>();
      // A machine refresh can change this cwd's snapshot, so the scan publishes against the result.
      const refreshMachineSnapshot = input.fresh
        ? (instance.invalidateCaches ?? Effect.void).pipe(
            Effect.andThen(refreshInstance(input.instanceId)),
            Effect.andThen(getProviders),
            Effect.map((current) =>
              current.find((candidate) => candidate.instanceId === input.instanceId),
            ),
          )
        : Effect.succeed(provider);
      const runScan = refreshMachineSnapshot.pipe(
        Effect.flatMap((scanBase) =>
          snapshotForCwd(input.scanCwd ?? input.cwd).pipe(
            Effect.flatMap(globalSkills.workspace(scanBase ?? provider)),
            Effect.map((scopedSnapshot) => ({ scanBase, scopedSnapshot })),
          ),
        ),
        // Scans fail on error; returned inventory remains valid even when provider health reports an error.
        Effect.flatMap(({ scanBase, scopedSnapshot }) =>
          instanceRegistry.getInstance(input.instanceId).pipe(
            Effect.flatMap((currentInstance) => {
              if (currentInstance !== instance) return getProviders;
              return updateProviders((currentProviders) => {
                // Read ownership inside the update so a newer claim cannot race publication.
                if (Ref.getUnsafe(workspaceRefreshesRef).get(instance)?.get(input.cwd) !== token) {
                  return currentProviders;
                }
                return currentProviders.map((candidate) => {
                  if (
                    candidate.instanceId !== input.instanceId ||
                    !sameWorkspaceCatalogBasis(scanBase, candidate) ||
                    !Equal.equals(workspaceSnapshotOf(candidate), workspaceSnapshotOf(scanBase))
                  )
                    return candidate;
                  const scanned = upsertProviderWorkspaceSnapshot(candidate, input.cwd, {
                    ...scopedSnapshot,
                    checkedAt: scannedAt,
                    slashCommandsPending:
                      scopedSnapshot.slashCommandsPending ?? scopedSnapshot.status === "error",
                  });
                  const next = workspaceSnapshotOf(scanned);
                  const previous = before ?? scannedFrom;
                  return input.rescan !== undefined &&
                    (!Equal.equals(next?.skills, previous?.skills) ||
                      !Equal.equals(next?.slashCommands, previous?.slashCommands))
                    ? { ...scanned, workspaceRescannedAt: scannedAt }
                    : scanned;
                });
              });
            }),
          ),
        ),
        Effect.catchCauseIf(
          (cause) => input.rescan !== undefined && !Cause.hasInterruptsOnly(cause),
          (cause) => {
            return isCurrentInstance(instance).pipe(
              Effect.flatMap((current) =>
                current
                  ? updateProviders((providers) => {
                      if (
                        Ref.getUnsafe(workspaceRefreshesRef).get(instance)?.get(input.cwd) !== token
                      )
                        return providers;
                      return providers.map((provider) =>
                        provider.instanceId === instance.instanceId
                          ? {
                              ...provider,
                              status: "error",
                              message: "Provider workspace rescan failed.",
                            }
                          : provider,
                      );
                    }).pipe(Effect.asVoid)
                  : Effect.void,
              ),
              Effect.andThen(Effect.failCause(cause)),
            );
          },
        ),
        Effect.ensuring(
          Ref.update(workspaceRefreshesRef, (refreshes) => {
            const current = refreshes.get(instance);
            if (current?.get(input.cwd) !== token) return refreshes;
            const next = new Map(refreshes);
            const nextCwds = new Map(current);
            nextCwds.delete(input.cwd);
            if (nextCwds.size) next.set(instance, nextCwds);
            else next.delete(instance);
            return next;
          }).pipe(Effect.andThen(Deferred.succeed(token, undefined))),
        ),
      );
      // The claim and the fork happen together, so the token is always completed. The scan is
      // detached so a disconnecting owner cannot cancel the result its waiters depend on.
      const claim = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const inFlight = yield* Ref.modify(workspaceRefreshesRef, (refreshes) => {
            const current = refreshes.get(instance);
            const running = current?.get(input.cwd);
            if (!input.fresh && running) return [running, refreshes] as const;
            const next = new Map(refreshes);
            next.set(instance, new Map(current).set(input.cwd, token));
            return [undefined, next] as const;
          });
          if (inFlight) return { inFlight } as const;
          return {
            // Starting now attaches the scan's `ensuring` before anything can close the scope.
            scan: yield* Effect.forkIn(runScan, serviceScope, { startImmediately: true }),
          } as const;
        }),
      );
      // Wait for the running scan: on-demand clients get its result only in this reply.
      if ("inFlight" in claim) {
        return yield* Deferred.await(claim.inFlight).pipe(Effect.andThen(getProviders));
      }
      return yield* Fiber.join(claim.scan);
    });

    yield* rescanQueue
      .run((instance, cwd) =>
        refreshWorkspaceSnapshot({ instanceId: instance.instanceId, cwd, rescan: instance }).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logError("Provider workspace rescan failed.", {
                  instanceId: instance.instanceId,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      )
      .pipe(Effect.forkScoped);

    const invalidateModelCaches = Effect.fn("ProviderRegistry.invalidateModelCaches")(function* (
      input: Parameters<ProviderRegistry["Service"]["invalidateModelCaches"]>[0],
    ) {
      yield* manifestService.forceRefresh;
      const instances = yield* instanceRegistry.listInstances;
      yield* Effect.forEach(
        instances.filter(
          (instance) => input.instanceId === undefined || input.instanceId === instance.instanceId,
        ),
        (instance) =>
          Effect.gen(function* () {
            yield* instance.invalidateCaches ?? Effect.void;
            // Instance and full refreshes resolve installer metadata fresh
            // themselves; a cached workspace refresh needs it resolved here.
            const maintenance = yield* instance.snapshot.resolveMaintenance({
              fresh:
                input.instanceId !== undefined && input.cwd !== undefined && input.fresh !== true,
            });
            yield* Effect.forEach(
              latestProviderVersionCacheKeys(maintenance),
              latestVersions.invalidate,
              { discard: true },
            );
          }),
        { concurrency: "unbounded", discard: true },
      );
    });

    return {
      getProviders,
      rescanGlobalSkills,
      refresh: (provider?: ProviderDriverKind) =>
        refresh(provider).pipe(Effect.catchCause(recoverRefreshFailure)),
      awaitInFlightRefresh,
      refreshInstance: (instanceId: ProviderInstanceId) =>
        refreshInstance(instanceId).pipe(Effect.catchCause(recoverRefreshFailure)),
      reloadSecretsAndRefresh: (instanceId, checked) =>
        (instanceRegistry.reloadSecrets?.(instanceId, checked) ?? Effect.void).pipe(
          Effect.andThen(syncLiveSourcesAndContinue),
          Effect.andThen(instanceId === undefined ? refresh() : refreshInstance(instanceId)),
          Effect.catchCause(recoverRefreshFailure),
          Scope.provide(serviceScope),
        ),
      refreshWorkspaceSnapshot: (input) =>
        refreshWorkspaceSnapshot(input).pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshAfterUpdate,
      invalidateModelCaches,
      refreshModelCatalog: catalogRefresh
        .check(refreshAll())
        .pipe(Effect.catchCause(recoverRefreshFailure), Effect.asVoid),
      getProviderMaintenanceCapabilitiesForInstance,
      setProviderMaintenanceActionState,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistry["Service"];
  }),
);
