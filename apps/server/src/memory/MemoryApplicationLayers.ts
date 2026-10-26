import * as PermissionProfiles from "../goatclaw/PermissionProfiles.ts";
// @effect-diagnostics nodeBuiltinImport:off - the closed import factory requires a synchronous UUID callback.
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveCommandPath } from "@goat/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as NodeCrypto from "node:crypto";
import { parseAsideMemory } from "../memory/imports/AsideMemoryImporter.ts";
import { parseClaudeMemory } from "../memory/imports/ClaudeMemoryImporter.ts";
import { parseCodexMemory } from "../memory/imports/CodexMemoryImporter.ts";
import {
  acquireMemoryImportReader,
  preflightMemoryImportStateDirectory,
  type MemoryImportReaderConfig,
} from "../memory/imports/MemoryImportReader.ts";
import { ProviderMemoryImportRuntime } from "../memory/imports/MemoryImportTypes.ts";
import { parseOmoMemory } from "../memory/imports/OmoMemoryImporter.ts";
import { makeProviderMemoryImport } from "../memory/imports/ProviderMemoryImport.ts";
import * as MemoryCompactor from "../memory/MemoryCompactor.ts";
import * as MemoryMaintenance from "../memory/MemoryFtsMaintenance.ts";
import * as MemoryGenerationHold from "../memory/MemoryGenerationHold.ts";
import * as MemoryHubAuth from "../memory/MemoryHubAuth.ts";
import * as MemoryHubHttp from "../memory/MemoryHubHttp.ts";
import * as MemoryHub from "../memory/MemoryHubService.ts";
import * as MemoryOwnerSourceReadPolicyBinding from "../memory/MemoryOwnerSourceReadPolicyBinding.ts";
import * as MemoryQuota from "../memory/MemoryQuotaService.ts";
import * as MemoryReportAdapter from "../memory/MemoryReportAdapter.ts";
import * as MemoryReportWorker from "../memory/MemoryReportWorker.ts";
import * as MemoryService from "../memory/MemoryService.ts";
import * as MemorySettings from "../memory/MemorySettingsService.ts";
import * as MemorySnapshot from "../memory/MemorySnapshot.ts";
import * as MemorySnapshotBinding from "../memory/MemorySnapshotBinding.ts";
import * as MemoryStore from "../memory/MemoryStore.ts";
import * as MemorySyncRuntimeLive from "../memory/MemorySyncRuntimeLive.ts";
import * as MemorySync from "../memory/MemorySyncService.ts";
import * as MemoryWorker from "../memory/MemoryWorker.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
// Effect wraps this raw Node HTTP server after its startup and write-error guards attach.

import { MemoryHubError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpRouter } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as ServerLayers from "../server.ts";

// Sync needs the core service at construction; source reads need Sync only at invocation.
// The application owns this single binding so neither service constructs a second core.
export class MemorySourceReadBinding extends Context.Service<
  MemorySourceReadBinding,
  {
    readonly readSource: MemoryService.MemorySourceReadAuthority["readSource"];
    readonly importSync: Pick<
      MemorySync.MemorySyncService["Service"],
      "readLocalReadiness" | "requireBootstrap" | "syncStatus"
    >;
    readonly bind: (sync: MemorySync.MemorySyncService["Service"]) => Effect.Effect<void>;
  }
>()("goat/memory/MemoryApplicationLayers/MemorySourceReadBinding") {}

/**
 * The memory application: core store, sync, hub, imports, snapshot and toolkits. server.ts calls
 * this once and passes its own persistence, settings, identity and text generation layers, so
 * every memory service shares those instances and each memory layer below exists once.
 */
export const makeMemoryApplicationLayers = (deps: {
  readonly layerPersistence: typeof ServerLayers.layerPersistence;
  readonly layerRepositoryIdentityResolver: typeof ServerLayers.layerRepositoryIdentityResolver;
  readonly layerServerSettings: typeof ServerLayers.layerServerSettings;
  readonly layerTextGeneration: typeof ServerLayers.layerTextGeneration;
}) => {
  const {
    layerPersistence,
    layerRepositoryIdentityResolver,
    layerServerSettings,
    layerTextGeneration,
  } = deps;

  const layerMemorySourceReadBinding = Layer.effect(
    MemorySourceReadBinding,
    Effect.gen(function* () {
      const current = yield* Ref.make<MemorySync.MemorySyncService["Service"] | null>(null);
      return MemorySourceReadBinding.of({
        readSource: (input, permit) =>
          Ref.get(current).pipe(
            Effect.flatMap((sync) =>
              sync === null
                ? Effect.fail(new MemoryHubError({ code: "route_unavailable" }))
                : sync.readSource(input, permit),
            ),
          ),
        importSync: {
          readLocalReadiness: () =>
            Ref.get(current).pipe(
              Effect.flatMap((sync) =>
                sync === null
                  ? Effect.fail(new MemoryHubError({ code: "route_unavailable" }))
                  : sync.readLocalReadiness(),
              ),
            ),
          requireBootstrap: (space) =>
            Ref.get(current).pipe(
              Effect.flatMap((sync) =>
                sync === null
                  ? Effect.fail(new MemoryHubError({ code: "route_unavailable" }))
                  : sync.requireBootstrap(space),
              ),
            ),
          syncStatus: (input, permit) =>
            Ref.get(current).pipe(
              Effect.flatMap((sync) =>
                sync === null
                  ? Effect.fail(new MemoryHubError({ code: "route_unavailable" }))
                  : sync.syncStatus(input, permit),
              ),
            ),
        },
        bind: (sync) => Ref.set(current, sync),
      });
    }),
  );
  // One layer reference for the worker and layerMemorySync, so the worker, conflict resolution and
  // the status read share one set of holds. The registry supplies the provider version in each key.
  const layerMemoryGenerationHold = MemoryGenerationHold.layer.pipe(
    Layer.provide(ProviderRegistry.layer),
  );
  const layerMemoryQuota = MemoryQuota.layer.pipe(Layer.provideMerge(MemoryStore.layer));
  const layerMemorySourceReadService = Layer.unwrap(
    Effect.gen(function* () {
      const binding = yield* MemorySourceReadBinding;
      return MemoryService.layerWithSourceReadAuthority(binding.readSource);
    }),
  ).pipe(Layer.provide(layerMemorySourceReadBinding));
  const layerMemoryService = layerMemorySourceReadService.pipe(
    Layer.provide(layerServerSettings),
    Layer.provideMerge(layerMemoryQuota),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerRepositoryIdentityResolver),
    Layer.provide(layerPersistence),
  );
  const layerMemoryWorker = Layer.mergeAll(
    MemoryWorker.layer,
    MemoryReportWorker.layer.pipe(Layer.provide(MemoryReportAdapter.layer)),
  ).pipe(
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provideMerge(layerMemoryService),
    Layer.provide(MemoryMaintenance.layer.pipe(Layer.provide(layerMemoryQuota))),
    Layer.provide(RuntimeLayer.layerEventSink),
    Layer.provide(layerTextGeneration),
    Layer.provide(RuntimeIdentity.layer),
    Layer.provide(layerMemoryGenerationHold),
  );
  const layerMemoryStarted = Layer.effectDiscard(
    Effect.gen(function* () {
      const worker = yield* MemoryWorker.MemoryWorker;
      yield* worker.start();
      const reports = yield* MemoryReportWorker.MemoryReportWorker;
      yield* reports.start();
    }),
  ).pipe(Layer.provideMerge(layerMemoryWorker));

  // These layers are also used by the real-store HTTP scenarios. Dependencies are
  // supplied by the application, so WP2 and the hub share one core and settings owner.
  const layerMemoryHubServices = Layer.mergeAll(
    MemoryHub.layer,
    MemoryHub.administratorLayer,
    MemoryCompactor.layer,
    MemoryHubAuth.layer,
  ).pipe(
    Layer.provideMerge(MemoryHub.activityLayer),
    Layer.provideMerge(
      Layer.effect(
        MemoryHub.MemoryHubConfiguration,
        Effect.gen(function* () {
          const settings = yield* ServerSettings.MemoryHubCommittedSettings;
          const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
          const hubEnvironmentId = yield* identity.getEnvironmentId;
          return MemoryHub.MemoryHubConfiguration.of({
            read: settings.read.pipe(
              Effect.map(({ settings: memoryHub }) =>
                memoryHub.mode === "hub" && memoryHub.memorySpaceId !== null
                  ? { memorySpaceId: memoryHub.memorySpaceId, hubEnvironmentId }
                  : null,
              ),
            ),
          });
        }),
      ),
    ),
  );

  // L3's interface tag has the L2 runtime key. Supply the actual instance, without
  // constructing another service or introducing a per-request runtime.
  const layerMemoryHubHttpService = Layer.effect(
    MemoryHubHttp.MemoryHubService,
    MemoryHub.MemoryHubService,
  );
  const layerMemoryHubRoutes = MemoryHubHttp.layer.pipe(
    HttpRouter.provideRequest(layerMemoryHubHttpService),
    Layer.provide(layerMemoryHubHttpService),
  );

  const layerMemoryHubStarted = Layer.effectDiscard(
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const configuration = yield* MemoryHub.MemoryHubConfiguration;
      const store = yield* MemoryStore.MemoryStore;
      const compactor = yield* MemoryCompactor.MemoryCompactor;
      const applicationScope = yield* Scope.Scope;
      // Subscribe before readiness/read to retain a concurrent first enable.
      const changes = yield* settings.subscribeChanges;
      const readyPrincipal = Effect.gen(function* () {
        const hub = yield* configuration.read;
        if (!hub) return Option.none();
        return yield* store.transact(
          Effect.gen(function* () {
            const member = yield* store.readHubMember(hub.memorySpaceId, hub.hubEnvironmentId);
            const retention = yield* store.readHubRetentionTx(hub.memorySpaceId);
            if (!member || member.status !== "active" || retention.checkpointId === null)
              return yield* new MemoryHubError({ code: "bootstrap_required" });
            return Option.some({
              memorySpaceId: hub.memorySpaceId,
              environmentId: hub.hubEnvironmentId,
              credentialVersion: member.credentialVersion,
              scopes: ["memory:sync"] as const,
            });
          }),
        );
      });
      // One start in this application scope, after migrations, settings and the
      // published initial membership checkpoint. Disabled startup has no sweep.
      yield* Stream.concat(Stream.succeed(undefined), changes).pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const principal = yield* readyPrincipal;
            if (Option.isNone(principal)) return false;
            const startScope = yield* Scope.fork(applicationScope);
            yield* compactor.start(principal.value).pipe(
              Effect.provideService(Scope.Scope, startScope),
              // Release subscriptions from a failed sweep; a successful start
              // keeps its child scope until the application closes.
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Scope.close(startScope, exit) : Effect.void,
              ),
            );
            return true;
          }).pipe(
            // Readiness and the initial sweep can race with disable. Keep the
            // settings subscription alive and retry on the next transition.
            Effect.catch((error) =>
              Effect.logWarning("Memory compactor startup deferred", { errorTag: error._tag }).pipe(
                Effect.as(false),
              ),
            ),
          ),
        ),
        Stream.filter((started) => started),
        Stream.take(1),
        Stream.runDrain,
        // Startup marks settings ready after building its dependencies. Await it
        // in the scoped fiber so acquisition cannot deadlock that startup.
        (run) => Effect.andThen(settings.ready, run),
        Effect.forkScoped,
      );
    }),
  );

  const layerMemoryHub = layerMemoryHubStarted.pipe(
    Layer.provideMerge(layerMemoryHubServices),
    Layer.provideMerge(layerMemoryService),
    Layer.provideMerge(layerServerSettings),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ServerSecretStore.layer),
  );
  const layerRegisteredMemoryHub = layerMemoryHubRoutes.pipe(
    HttpRouter.provideRequest(layerMemoryHub),
    Layer.provideMerge(layerMemoryHub),
  );
  const layerMemoryDefaultStarted = Layer.effectDiscard(
    Effect.gen(function* () {
      const sync = yield* MemorySync.MemorySyncService;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* Effect.andThen(settings.ready, sync.initializeDefaultHub).pipe(
        Effect.catch(() =>
          Effect.logWarning("memory initialization unavailable", {
            code: "memory_default_unavailable",
          }),
        ),
        Effect.forkScoped,
      );
    }),
  );
  const layerMemorySyncStarted = Layer.merge(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const sync = yield* MemorySync.MemorySyncService;
        const binding = yield* Effect.serviceOption(MemorySourceReadBinding);
        if (Option.isSome(binding)) yield* binding.value.bind(sync);
        yield* sync.start;
      }),
    ),
    layerMemoryDefaultStarted,
  ).pipe(Layer.provideMerge(MemorySync.layer));

  /** Shared production runtime composition, including the single committed policy adapter. */
  const layerMemorySyncRuntime = MemorySyncRuntimeLive.layer.pipe(
    Layer.provideMerge(MemoryOwnerSourceReadPolicyBinding.layer),
  );
  const layerMemorySync = layerMemorySyncStarted.pipe(
    Layer.provide(layerMemorySourceReadBinding),
    Layer.provideMerge(layerMemorySyncRuntime),
    Layer.provide(layerMemoryHub),
    Layer.provide(layerTextGeneration),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerMemoryGenerationHold),
  );

  /** Acquisition is isolated from the core graph; only a fully acquired reader publishes the tag. */
  const layerMemoryImport = (config?: MemoryImportReaderConfig) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const service = yield* MemoryService.MemoryService;
        const { importSync: sync } = yield* MemorySourceReadBinding;
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        const environmentId = yield* identity.getEnvironmentId;
        const server = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const home = yield* HostProcess.HomeDirectory;
        const gitExecutable =
          config === undefined ? yield* resolveCommandPath("git") : config.gitExecutable;
        const readerConfig = config ?? {
          stateDir: server.stateDir,
          ...(gitExecutable ? { gitExecutable } : {}),
          roots: [
            { format: "codex", rootSlot: "default", path: path.join(home, ".codex") },
            { format: "claude", rootSlot: "default", path: path.join(home, ".claude", "projects") },
            {
              format: "omo",
              rootSlot: "default",
              path: path.join(home, ".omo", "memory", "agents"),
            },
            { format: "aside", rootSlot: "default", path: path.join(home, ".aside", "u") },
          ],
        };
        const reader = yield* preflightMemoryImportStateDirectory(readerConfig.stateDir).pipe(
          Effect.andThen(acquireMemoryImportReader(readerConfig)),
          Effect.result,
        );
        if (reader._tag === "Failure") {
          yield* Effect.logWarning("Provider memory import unavailable", {
            issue: reader.failure.issue,
            ...(reader.failure.issue === "path_rejected"
              ? {
                  stateDir: readerConfig.stateDir,
                  recovery:
                    "Match the stateDir owner to the server execution UID. If shared writes are not needed, remove group/other write permission and restart. If shared writes are needed, use a dedicated stateDir.",
                }
              : {}),
          });
          return Layer.empty;
        }
        return Layer.succeed(
          ProviderMemoryImportRuntime,
          makeProviderMemoryImport(
            {
              ...service.importPorts,
              readiness: sync.readLocalReadiness,
              requireBootstrap: sync.requireBootstrap,
              syncStatus: sync.syncStatus,
            },
            reader.success,
            {
              codex: parseCodexMemory,
              claude: parseClaudeMemory,
              omo: parseOmoMemory,
              aside: parseAsideMemory,
            },
            {
              uuid: () => NodeCrypto.randomUUID(),
              now: () => Clock.currentTimeMillis,
              environmentId,
            },
          ),
        );
      }),
    );
  const layerProviderMemoryImport = layerMemoryImport().pipe(
    Layer.provide(layerMemoryService),
    Layer.provide(layerMemorySourceReadBinding),
    Layer.provide(ServerEnvironment.layerIdentity),
  );

  const layerMemorySnapshot = MemorySnapshot.layer;
  const provideMemorySnapshot = MemorySnapshotBinding.provide;
  const layerMemorySnapshotWithDependencies = layerMemorySnapshot.pipe(
    Layer.provide(layerMemorySync),
    Layer.provide(layerMemoryService),
    Layer.provide(layerMemoryQuota),
    Layer.provide(ProjectionStoreV2.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerPersistence),
  );

  // Production serves the same handler set the catalog and its tests register.
  const layerMemoryAdministrationToolkit = McpHttpServer.layerMemoryAdministrationToolkit.pipe(
    Layer.provide(MemorySettings.layer),
  );

  const layerMemoryToolkits = Layer.mergeAll(
    McpHttpServer.layerMemoryToolkit,
    layerMemoryAdministrationToolkit,
    // The goatclaw capability gate on every MCP registration reads the caller's profile.
  ).pipe(Layer.provide(PermissionProfiles.layer));

  return {
    layerMemorySourceReadBinding,
    layerMemorySourceReadService,
    layerMemoryHubServices,
    layerMemoryHubRoutes,
    layerMemoryHubStarted,
    layerMemoryDefaultStarted,
    layerMemorySyncStarted,
    layerMemorySyncRuntime,
    layerMemoryImport,
    layerMemorySnapshot,
    provideMemorySnapshot,
    layerMemoryToolkits,
    layerMemoryService,
    layerMemoryStarted,
    layerMemoryHub,
    layerRegisteredMemoryHub,
    layerMemorySync,
    layerProviderMemoryImport,
    layerMemorySnapshotWithDependencies,
  };
};
