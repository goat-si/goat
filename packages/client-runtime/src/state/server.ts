import { providerWorkspaceRefreshKey } from "../providerWorkspaceRefreshKey.ts";
import { processResourceHistoryOptions } from "./serverResourceHistory.ts";
import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type ServerLifecycleStreamReadyEvent,
  type ServerProviderWorkspaceSnapshot,
  type ServerSelfUpdateResult,
  shouldRecommendDatabaseCompaction,
  REMOTE_LAUNCHES_WS_METHODS,
  WS_METHODS,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Equal from "effect/Equal";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  createRuntimeCommand,
  scheduleAtomCommandEffect,
} from "./runtime.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { createProviderAuthCommands } from "./providerAuthCommands.ts";
import * as Persistence from "../platform/persistence.ts";
import { createDecisionEnvironmentAtoms } from "./decisionRpc.ts";
import { createHubMachinesAtoms } from "./hubMachines.ts";
import { createHubDeviceCommands } from "./hubDeviceCommands.ts";
import { readUsageSummary } from "./serverUsageSummary.ts";
import {
  currentSession,
  request,
  requestGuarded,
  requestInSession,
  runStream,
  runStreamInSession,
  subscribe,
  subscribeDynamicWithSession,
  type EnvironmentRpcInput,
} from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import { createOpenCodexSyncAtoms } from "./opencodexSync.ts";
import { createStorageEnvironmentAtoms } from "./storage.ts";
import { reuseUnchanged, type ServerConfigProjection } from "./serverConfigProjection.ts";

import {
  serverConfigStateChanges,
  type ServerConfigSubscriptionOptions,
} from "./serverConfigState.ts";

import type { FetchedMachineCatalog } from "./serverProviderCatalog.ts";

import {
  type ServerUpdateTarget,
  SERVER_UPDATE_RESUME_TIMEOUT,
  ServerUpdateResumeTimeoutError,
  isLegacyUpdateHandoffLoss,
  matchesServerUpdateResumeEvent,
  nudgeReconnectDuringUpdateRestart,
  readAcceptingReady,
  resolveServerUpdateProgressResult,
  runDesktopCommitWithReconnectObserver,
  serverUpdateFailureMessage,
  serverUpdateStateForProgressEvent,
  serverUpdateStateForServerVersion,
  validateServerUpdateReadyEvent,
  waitForDesktopUpdateTarget,
} from "./serverUpdate.ts";

export {
  makeEnvironmentServerConfigState,
  type ServerConfigSubscriptionOptions,
} from "./serverConfigState.ts";
export type { ServerConfigProjection } from "./serverConfigProjection.ts";
export * from "./serverUpdate.ts";

export type ServerUpdateStage = "downloading" | "installing" | "resuming";

export type ServerUpdateState =
  | { readonly status: "idle" }
  | {
      readonly status: "running";
      readonly stage: ServerUpdateStage;
      readonly fromVersion: string;
      readonly targetVersion: string;
      /** The service launcher's id for an accepted update, used to find its outcome later. */
      readonly updateId?: string;
    }
  | {
      readonly status: "failed";
      readonly stage: ServerUpdateStage;
      readonly fromVersion: string;
      readonly targetVersion: string;
      readonly message: string;
    };

export const IDLE_SERVER_UPDATE_STATE: ServerUpdateState = { status: "idle" };
const EMPTY_SERVER_UPDATE_STATE_ATOM = Atom.make<ServerUpdateState>(IDLE_SERVER_UPDATE_STATE).pipe(
  Atom.withLabel("environment-data:server:update-state:empty"),
);
export const serverUpdateStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<ServerUpdateState>(IDLE_SERVER_UPDATE_STATE).pipe(
    Atom.withLabel(`environment-data:server:update-state:${environmentId}`),
  ),
);

export function applyServerWelcomeEvent(
  current: EnvironmentServerWelcomeState,
  session: RpcSession,
  event: {
    readonly type: "welcome" | "ready" | "legacyThreadMigration" | "runtimeDrain";
    readonly payload: unknown;
  },
): EnvironmentServerWelcomeState {
  return event.type === "welcome" && current.currentSession === session
    ? {
        ...current,
        welcomeSession: session,
        welcome: event.payload as ServerLifecycleWelcomePayload,
      }
    : current;
}

export interface EnvironmentServerWelcomeState {
  readonly currentSession: RpcSession | null;
  readonly welcomeSession: RpcSession | null;
  readonly welcome: ServerLifecycleWelcomePayload | null;
}

export function resolveServerWelcomeState(
  state: EnvironmentServerWelcomeState,
): ServerLifecycleWelcomePayload | null {
  return state.currentSession === state.welcomeSession ? state.welcome : null;
}

export const makeEnvironmentServerWelcomeState = Effect.fn("EnvironmentServerWelcomeState.make")(
  function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const initialSession = Option.getOrNull(yield* SubscriptionRef.get(supervisor.session));
    const state = yield* SubscriptionRef.make<EnvironmentServerWelcomeState>({
      currentSession: initialSession,
      welcomeSession: null,
      welcome: null,
    });

    const updateWithCurrentSession = Effect.fn(
      "EnvironmentServerWelcomeState.updateWithCurrentSession",
    )(function* (
      update: (
        current: EnvironmentServerWelcomeState,
        currentSession: RpcSession | null,
      ) => EnvironmentServerWelcomeState,
    ) {
      return yield* SubscriptionRef.modifyEffect(state, (current) =>
        SubscriptionRef.get(supervisor.session).pipe(
          Effect.map(
            (latestSession) =>
              [undefined, update(current, Option.getOrNull(latestSession))] as const,
          ),
        ),
      );
    });

    yield* SubscriptionRef.changes(supervisor.session).pipe(
      Stream.runForEach(() =>
        updateWithCurrentSession((current, currentSession) => ({
          ...current,
          currentSession,
        })),
      ),
      Effect.forkScoped,
    );

    yield* subscribeDynamicWithSession(
      WS_METHODS.subscribeServerLifecycle,
      Effect.fn("EnvironmentServerWelcomeState.makeSubscribeInput")(function* (session) {
        yield* updateWithCurrentSession((current, currentSession) =>
          currentSession === session
            ? {
                ...current,
                currentSession,
                welcomeSession: session,
                welcome: null,
              }
            : { ...current, currentSession },
        );
        return {};
      }),
    ).pipe(
      Stream.runForEach(([session, event]) =>
        updateWithCurrentSession((current, currentSession) =>
          applyServerWelcomeEvent(
            {
              ...current,
              currentSession,
            },
            session,
            event,
          ),
        ),
      ),
      Effect.forkScoped,
    );

    return state;
  },
);

function serverWelcomeStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentServerWelcomeState().pipe(
        Effect.map((state) =>
          SubscriptionRef.changes(state).pipe(Stream.map(resolveServerWelcomeState)),
        ),
      ),
    ),
  );
}

export function resolveServerConfigValue(
  projection: ServerConfigProjection | null,
  initialConfig: ServerConfig | null,
): ServerConfig | null {
  if (
    projection?.source === "live" &&
    (initialConfig === null ||
      projection.config.environment.serverVersion === initialConfig.environment.serverVersion)
  ) {
    return projection.config;
  }
  return initialConfig ?? projection?.config ?? null;
}

type ServerProviderEntry = ServerConfig["providers"][number];

function snapshotBasis(provider: ServerProviderEntry | undefined, reply?: ServerProviderEntry) {
  if (!provider) return undefined;
  // A cwd reply carries the observed installation but omits the machine models.
  return {
    enabled: provider.enabled,
    refreshKey: providerWorkspaceRefreshKey(provider, reply),
    models: provider.models,
    ...(reply?.catalogDigest === undefined && provider.catalogDigest === undefined
      ? { slashCommands: provider.slashCommands, skills: provider.skills }
      : {}),
  };
}

interface FetchedWorkspaceSnapshot {
  readonly instanceId: ProviderInstanceId;
  readonly snapshot: ServerProviderWorkspaceSnapshot;
  readonly basis: ReturnType<typeof snapshotBasis>;
}

const MAX_FETCHED_WORKSPACE_SNAPSHOTS = 32;

/**
 * Servers with `providerWorkspaceSnapshotsOnDemand` leave per-cwd snapshots out of the config,
 * so the ones this client fetched are merged back in. Older servers send every snapshot and
 * their drops, so their config is used as is.
 */
export function withFetchedWorkspaceSnapshots(
  config: ServerConfig,
  fetched: ReadonlyArray<FetchedWorkspaceSnapshot>,
): ServerConfig {
  if (
    fetched.length === 0 ||
    config.environment.capabilities.providerWorkspaceSnapshotsOnDemand !== true
  ) {
    return config;
  }
  return {
    ...config,
    providers: config.providers.map((provider) => {
      // A dropped snapshot reads as lost, and the composer fetches it again.
      const own = fetched.filter(
        (entry) =>
          entry.instanceId === provider.instanceId &&
          Equal.equals(entry.basis, snapshotBasis(provider)),
      );
      return own.length === 0
        ? provider
        : { ...provider, workspaceSnapshots: own.map((entry) => entry.snapshot) };
    }),
  };
}

export function recordFetchedWorkspaceSnapshot(
  current: ReadonlyArray<FetchedWorkspaceSnapshot>,
  input: { readonly instanceId: ProviderInstanceId; readonly cwd: string; readonly fresh: boolean },
  providers: ServerConfig["providers"],
  configProvider: ServerProviderEntry | undefined,
): ReadonlyArray<FetchedWorkspaceSnapshot> {
  const reply = providers.find((provider) => provider.instanceId === input.instanceId);
  const basis = snapshotBasis(configProvider, reply);
  const snapshot = reply?.workspaceSnapshots?.find((candidate) => candidate.cwd === input.cwd);
  const stored = current.find(
    (entry) => entry.instanceId === input.instanceId && entry.snapshot.cwd === input.cwd,
  );
  // A cached answer from the server would otherwise re-render every config reader.
  if (
    !input.fresh &&
    snapshot &&
    stored &&
    Equal.equals(stored.snapshot, snapshot) &&
    Equal.equals(stored.basis, basis)
  ) {
    return current;
  }
  // A fresh scan drops the cwd's snapshots for every provider, as the server does.
  const kept = current.filter(
    (entry) =>
      entry.snapshot.cwd !== input.cwd || (!input.fresh && entry.instanceId !== input.instanceId),
  );
  if (!snapshot) return kept.length === current.length ? current : kept;
  return [...kept, { instanceId: input.instanceId, snapshot, basis }].slice(
    -MAX_FETCHED_WORKSPACE_SNAPSHOTS,
  );
}

export function createServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E
  >,
  options: ServerConfigSubscriptionOptions & {
    readonly initialConfigValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ServerConfig | null>;
  },
) {
  const configScheduler = createAtomCommandScheduler();
  const updateScheduler = createAtomCommandScheduler();
  const configConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const fetchedMachineCatalogsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<FetchedMachineCatalog>>([]).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:server:fetched-machine-catalogs:${environmentId}`),
    ),
  );
  const configProjectionFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) =>
        serverConfigStateChanges(
          environmentId,
          options,
          options.providerCatalogDigests === true
            ? AtomRegistry.toStream(get.registry, fetchedMachineCatalogsAtom(environmentId))
            : Stream.empty,
        ),
      )
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:server:config-projection:${environmentId}`),
      ),
  );
  const configProjection = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.subscribeServerConfig>;
  }) => configProjectionFamily(target.environmentId);
  const fetchedWorkspaceSnapshotsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<FetchedWorkspaceSnapshot>>([]).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:server:fetched-workspace-snapshots:${environmentId}`),
    ),
  );
  const emptyConfigAtom = Atom.make<ServerConfig | null>(null).pipe(
    Atom.withLabel("environment-data:server:config:empty"),
  );
  const configValueAtom = Atom.family((environmentId: EnvironmentId | null) => {
    if (environmentId === null) {
      return emptyConfigAtom;
    }
    let previousProviders: ServerConfig["providers"] | undefined;
    return Atom.make((get): ServerConfig | null => {
      const projection = Option.getOrNull(
        AsyncResult.value(get(configProjection({ environmentId, input: {} }))),
      );
      const config = resolveServerConfigValue(
        projection,
        get(options.initialConfigValueAtom(environmentId)),
      );
      if (config === null) return null;
      const merged = withFetchedWorkspaceSnapshots(
        config,
        get(fetchedWorkspaceSnapshotsAtom(environmentId)),
      );
      if (merged === config) return config;
      // Keep provider identities stable across config events; the projection already reuses the rest.
      previousProviders = reuseUnchanged(previousProviders, merged.providers);
      return { ...merged, providers: previousProviders };
    }).pipe(Atom.withLabel(`environment-data:server:config:${environmentId}`));
  });
  const updateStateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      serverUpdateStateForServerVersion(
        get(serverUpdateStateAtom(environmentId)),
        get(configValueAtom(environmentId))?.environment.serverVersion ?? null,
      ),
    ).pipe(Atom.withLabel(`environment-data:server:update-state-value:${environmentId}`)),
  );
  const updateStateAtom = (environmentId: EnvironmentId | null) =>
    environmentId === null ? EMPTY_SERVER_UPDATE_STATE_ATOM : updateStateValueAtom(environmentId);
  const updateServer = createRuntimeCommand<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E,
    ServerUpdateTarget,
    ServerSelfUpdateResult,
    unknown
  >(runtime, {
    label: "environment-data:server:update-server",
    scheduler: updateScheduler,
    concurrency: configConcurrency,
    execute: Effect.fn("ServerUpdate.updateServer")(function (target, atomRegistry) {
      const stateAtom = serverUpdateStateAtom(target.environmentId);
      let targetVersion = target.input.targetVersion;
      let fromVersion =
        atomRegistry.get(configValueAtom(target.environmentId))?.environment.serverVersion ??
        targetVersion;
      let currentStage: ServerUpdateStage = "downloading";
      let desktopCommitLostTransport = false;
      atomRegistry.set(stateAtom, {
        status: "running",
        stage: currentStage,
        fromVersion,
        targetVersion,
      });

      return Effect.gen(function* () {
        const environmentRegistry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const desktopCommitStarting = yield* Deferred.make<void>();
        const desktopReconnectObserverArmed = yield* Deferred.make<void>();
        const desktopReconnected = yield* Deferred.make<void>();
        let accepting: { readonly session: RpcSession; readonly at: string } | undefined;
        let acceptedAt: string | undefined;
        // The baseline only describes the accepting process if the request rides its session,
        // so the session read here is the one the request is sent on.
        const acceptingSession = currentSession().pipe(
          Effect.tap((session) =>
            Effect.sync(() => {
              acceptedAt = accepting?.session === session ? accepting.at : undefined;
            }),
          ),
        );
        yield* Deferred.await(desktopCommitStarting).pipe(
          Effect.andThen(
            environmentRegistry.stateChanges(target.environmentId).pipe(
              Stream.tap(() => Deferred.succeed(desktopReconnectObserverArmed, undefined)),
              Stream.dropWhile((state) => state.phase === "connected"),
              Stream.filter((state) => state.phase === "connected"),
              Stream.runHead,
            ),
          ),
          Effect.andThen(Deferred.succeed(desktopReconnected, undefined)),
          Effect.forkChild,
        );
        const result = yield* scheduleAtomCommandEffect(
          atomRegistry,
          configScheduler,
          configConcurrency,
          target,
          Effect.gen(function* () {
            const currentConfig = atomRegistry.get(configValueAtom(target.environmentId));
            fromVersion = currentConfig?.environment.serverVersion ?? targetVersion;
            atomRegistry.set(stateAtom, {
              status: "running",
              stage: currentStage,
              fromVersion,
              targetVersion,
            });
            // Only launcher updates carry an updateId. Read before the request so a ready from
            // after it can never pose as the accepting process.
            if (currentConfig?.environment.capabilities.serverSelfUpdate === "boot-service") {
              accepting = yield* readAcceptingReady(environmentRegistry, target.environmentId);
            }
            const supportsProgress =
              currentConfig?.environment.capabilities.serverSelfUpdateProgress === true;
            const updateResult: ServerSelfUpdateResult = supportsProgress
              ? yield* Effect.gen(function* () {
                  let receivedProgress = false;
                  const terminal = yield* Ref.make<Option.Option<ServerSelfUpdateResult>>(
                    Option.none(),
                  );
                  const streamExit = yield* environmentRegistry
                    .runStream(
                      target.environmentId,
                      Stream.unwrap(
                        acceptingSession.pipe(
                          Effect.map((session) =>
                            runStreamInSession(
                              session,
                              WS_METHODS.serverUpdateServerWithProgress,
                              target.input,
                            ),
                          ),
                        ),
                      ),
                    )
                    .pipe(
                      Stream.runForEach((event) =>
                        Effect.sync(() => {
                          receivedProgress ||= event.type === "progress";
                          const state = serverUpdateStateForProgressEvent(
                            fromVersion,
                            targetVersion,
                            event,
                          );
                          currentStage = state.stage;
                          atomRegistry.set(stateAtom, state);
                        }).pipe(
                          Effect.andThen(
                            event.type === "complete"
                              ? Ref.set(terminal, Option.some(event.result))
                              : Effect.void,
                          ),
                        ),
                      ),
                      Effect.exit,
                    );
                  const selfUpdateMethod = currentConfig?.environment.capabilities.serverSelfUpdate;
                  // Desktop preparation needs its terminal commit token.
                  const accepted =
                    receivedProgress &&
                    (selfUpdateMethod === "boot-service" || selfUpdateMethod === "respawn")
                      ? { targetVersion, method: selfUpdateMethod }
                      : undefined;
                  return yield* resolveServerUpdateProgressResult(
                    targetVersion,
                    yield* Ref.get(terminal),
                    streamExit,
                    accepted,
                  );
                })
              : yield* Effect.gen(function* () {
                  const selfUpdateMethod = currentConfig?.environment.capabilities.serverSelfUpdate;
                  const exit = yield* environmentRegistry
                    .run(
                      target.environmentId,
                      acceptingSession.pipe(
                        Effect.flatMap((session) =>
                          requestInSession(session, WS_METHODS.serverUpdateServer, target.input),
                        ),
                      ),
                    )
                    .pipe(Effect.exit);
                  if (Exit.isSuccess(exit)) {
                    return exit.value;
                  }
                  if (
                    (selfUpdateMethod === "boot-service" || selfUpdateMethod === "respawn") &&
                    isLegacyUpdateHandoffLoss(exit.cause)
                  ) {
                    // Older servers can tear down the transport before their
                    // unary acknowledgement arrives. Treat only that transport
                    // loss as a handoff, then prove it by waiting for target ready.
                    return { targetVersion, method: selfUpdateMethod };
                  }
                  return yield* Effect.failCause(exit.cause);
                });

            if (
              updateResult.method === "desktop-app" &&
              updateResult.desktopUpdateToken !== undefined
            ) {
              yield* Deferred.succeed(desktopCommitStarting, undefined);
              yield* Deferred.await(desktopReconnectObserverArmed);
              const commitExit = yield* environmentRegistry
                .run(
                  target.environmentId,
                  request(WS_METHODS.serverCommitDesktopUpdate, {
                    requestId: updateResult.desktopUpdateToken,
                  }),
                )
                .pipe(Effect.exit);
              if (Exit.isFailure(commitExit) && !isLegacyUpdateHandoffLoss(commitExit.cause)) {
                return yield* Effect.failCause(commitExit.cause);
              }
              desktopCommitLostTransport = Exit.isFailure(commitExit);
            }

            targetVersion = updateResult.targetVersion;

            currentStage = "resuming";
            atomRegistry.set(stateAtom, {
              status: "running",
              stage: currentStage,
              fromVersion,
              targetVersion,
              ...(updateResult.updateId === undefined ? {} : { updateId: updateResult.updateId }),
            });
            return updateResult;
          }),
        );

        yield* nudgeReconnectDuringUpdateRestart({
          stateChanges: environmentRegistry.stateChanges(target.environmentId),
          retryNow: environmentRegistry.retryNow(target.environmentId),
        }).pipe(Effect.forkChild);

        if (result.method === "desktop-app" && desktopCommitLostTransport) {
          yield* Deferred.await(desktopReconnected).pipe(
            Effect.timeout(SERVER_UPDATE_RESUME_TIMEOUT),
          );
        }

        const waitForReady = environmentRegistry
          .followStream(target.environmentId, subscribe(WS_METHODS.subscribeServerLifecycle, {}))
          .pipe(
            Stream.filter(
              (event): event is ServerLifecycleStreamReadyEvent =>
                event.type === "ready" && matchesServerUpdateResumeEvent(result, event, acceptedAt),
            ),
            Stream.runHead,
            Effect.timeoutOption(SERVER_UPDATE_RESUME_TIMEOUT),
            Effect.map(Option.flatten),
          );
        const nextReady = waitForReady.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                new ServerUpdateResumeTimeoutError({
                  environmentId: target.environmentId,
                  targetVersion,
                }),
              onSome: Effect.succeed,
            }),
          ),
        );
        const desktopUpdateToken = result.desktopUpdateToken;
        const resumed =
          result.method === "desktop-app" && desktopUpdateToken !== undefined
            ? yield* waitForDesktopUpdateTarget(
                result.targetVersion,
                nextReady,
                runDesktopCommitWithReconnectObserver(
                  environmentRegistry.stateChanges(target.environmentId),
                  environmentRegistry
                    .run(
                      target.environmentId,
                      request(WS_METHODS.serverCommitDesktopUpdate, {
                        requestId: desktopUpdateToken,
                      }),
                    )
                    .pipe(Effect.asVoid),
                ),
              )
            : yield* nextReady;
        yield* validateServerUpdateReadyEvent(result, resumed);

        atomRegistry.set(stateAtom, IDLE_SERVER_UPDATE_STATE);
        return result;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              return;
            }
            if (Cause.hasInterruptsOnly(exit.cause)) {
              atomRegistry.set(stateAtom, IDLE_SERVER_UPDATE_STATE);
              return;
            }
            atomRegistry.set(stateAtom, {
              status: "failed",
              stage: currentStage,
              fromVersion,
              targetVersion,
              message: serverUpdateFailureMessage(Cause.squash(exit.cause)),
            });
          }),
        ),
      );
    }),
  });
  const settingsValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.settings ?? null).pipe(
      Atom.withLabel(`environment-data:server:settings:${environmentId}`),
    ),
  );
  const worktreesDirectorySettingAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(settingsValueAtom(environmentId))?.worktreesDirectory ?? null).pipe(
      Atom.withLabel(`environment-data:server:worktrees-directory-setting:${environmentId}`),
    ),
  );
  const computerUseStatusChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:server:computer-use-status-changes",
    tag: WS_METHODS.computerUseStatusChanges,
    idleTtlMs: 0,
  });
  const computerUseRefreshAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const status = get(computerUseStatusChanges({ environmentId, input: {} }));
      // Older servers may reject the subscription; the status query still works on its own.
      const revision = AsyncResult.isSuccess(status) ? status.value.revision : null;
      return JSON.stringify([get(settingsValueAtom(environmentId))?.enableCua ?? false, revision]);
    }).pipe(Atom.withLabel(`environment-data:server:computer-use-refresh:${environmentId}`)),
  );
  const usagePricesAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const overrides = get(settingsValueAtom(environmentId))?.usagePriceOverrides ?? {};
      // Only changed prices should trigger another transcript scan. Settings
      // snapshots can recreate the same mapping in a different property order.
      return JSON.stringify(
        Object.keys(overrides)
          .sort()
          .map((model) => {
            const price = overrides[model]!;
            return [
              model,
              price.inputCostPerMillionTokens,
              price.outputCostPerMillionTokens,
              price.cacheReadCostPerMillionTokens,
              price.cacheWriteCostPerMillionTokens,
            ];
          }),
      );
    }).pipe(Atom.withLabel(`environment-data:server:usage-prices:${environmentId}`)),
  );
  const usageScanSettingsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const settings = get(settingsValueAtom(environmentId));
      const aliases = settings?.usageModelAliases ?? {};
      return JSON.stringify([
        get(usagePricesAtom(environmentId)),
        Object.keys(aliases)
          .sort()
          .map((model) => [model, aliases[model]]),
        settings?.cursorKeychainUsageEnabled ?? false,
      ]);
    }).pipe(Atom.withLabel(`environment-data:server:usage-scan-settings:${environmentId}`)),
  );
  // Settings snapshots rebuild the filter object; only a changed filter should touch the Usage tab.
  const usageModelFilterAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(settingsValueAtom(environmentId))?.usageModelFilter).pipe(
      Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      Atom.withLabel(`environment-data:server:usage-model-filter:${environmentId}`),
    ),
  );
  const providersValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.providers ?? null).pipe(
      Atom.withLabel(`environment-data:server:providers:${environmentId}`),
    ),
  );
  const welcomeStateFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(serverWelcomeStateChanges(environmentId), { initialValue: null })
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:server:welcome-state:${environmentId}`),
      ),
  );
  const welcomeFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const result = get(welcomeStateFamily(environmentId));
      if (result._tag !== "Success") return result;
      return result.value === null
        ? AsyncResult.initial<ServerLifecycleWelcomePayload, never>(result.waiting)
        : AsyncResult.success(result.value, result);
    }).pipe(Atom.withLabel(`environment-data:server:welcome:${environmentId}`)),
  );
  const databaseStorage = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:server:database-storage",
    tag: WS_METHODS.serverGetDatabaseStorage,
    idleTtlMs: 0,
  });
  // Keyed by a JSON array of environment ids so one notice can list every machine.
  const databaseCompactionRecommendations = Atom.family((environmentIdsKey: string) => {
    const sources = (JSON.parse(environmentIdsKey) as EnvironmentId[]).map((environmentId) => ({
      environmentId,
      atom: databaseStorage({ environmentId, input: {} }),
    }));
    return Atom.make((get) =>
      sources
        .flatMap(({ environmentId, atom }) => {
          const result = get(atom);
          return result._tag === "Success" &&
            result.value !== null &&
            shouldRecommendDatabaseCompaction(result.value)
            ? [{ environmentId, status: result.value }]
            : [];
        })
        .sort((left, right) => right.status.reclaimableBytes - left.status.reclaimableBytes),
    ).pipe(
      Atom.withLabel(
        `environment-data:server:database-compaction-recommendations:${environmentIdsKey}`,
      ),
    );
  });
  const welcome = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.subscribeServerLifecycle>;
  }) => welcomeFamily(target.environmentId);
  const updateSettings = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:update-settings",
    tag: WS_METHODS.serverUpdateSettings,
    scheduler: configScheduler,
    concurrency: configConcurrency,
  });
  /** Cloud agent runs this environment follows or links; Fleet reads them while open. */
  const cloudAgentRuns = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:cloud-agent-runs",
    tag: WS_METHODS.cloudAgentsListRuns,
    staleTimeMs: 5_000,
  });
  /** Boat machines this environment manages. Reading it never wakes a machine. */
  const cloudMachines = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:cloud-machines",
    tag: WS_METHODS.cloudMachinesList,
    staleTimeMs: 5_000,
  });
  const cloudMachineScheduler = createAtomCommandScheduler();
  const refreshCloudMachines = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.refresh(cloudMachines({ environmentId: target.environmentId, input: {} })),
    );
  /** Lifecycle changes to one machine run one at a time; a success refreshes the list. */
  const cloudMachineCommand = <
    TTag extends
      | typeof WS_METHODS.cloudMachinesConfigure
      | typeof WS_METHODS.cloudMachinesDisconnect
      | typeof WS_METHODS.cloudMachinesCreate
      | typeof WS_METHODS.cloudMachinesStop
      | typeof WS_METHODS.cloudMachinesResume
      | typeof WS_METHODS.cloudMachinesDelete
      | typeof WS_METHODS.cloudMachinesForget
      | typeof WS_METHODS.cloudMachinesDismissUnconfirmed
      | typeof WS_METHODS.cloudMachinesEnsureReady,
  >(
    tag: TTag,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:server:${tag}`,
      tag,
      scheduler: cloudMachineScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          `${environmentId}:${"alias" in input ? String(input.alias) : tag}`,
      },
      onSuccess: refreshCloudMachines,
    });
  const remoteLaunches = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:remote-launches",
    tag: WS_METHODS.remoteLaunchesList,
    staleTimeMs: 5_000,
    // A host can stop answering while the list is open; nothing pushes that change.
    refreshIntervalMs: 60_000,
  });
  return {
    cloudMachines,
    ...createOpenCodexSyncAtoms(runtime),
    cloudAgentRuns,
    configureCloudMachines: cloudMachineCommand(WS_METHODS.cloudMachinesConfigure),
    disconnectCloudMachines: cloudMachineCommand(WS_METHODS.cloudMachinesDisconnect),
    createCloudMachine: cloudMachineCommand(WS_METHODS.cloudMachinesCreate),
    stopCloudMachine: cloudMachineCommand(WS_METHODS.cloudMachinesStop),
    resumeCloudMachine: cloudMachineCommand(WS_METHODS.cloudMachinesResume),
    deleteCloudMachine: cloudMachineCommand(WS_METHODS.cloudMachinesDelete),
    forgetCloudMachine: cloudMachineCommand(WS_METHODS.cloudMachinesForget),
    dismissUnconfirmedCloudMachines: cloudMachineCommand(
      WS_METHODS.cloudMachinesDismissUnconfirmed,
    ),
    ensureCloudMachineReady: cloudMachineCommand(WS_METHODS.cloudMachinesEnsureReady),
    configValueAtom,
    runStorageCleanup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:run-storage-cleanup",
      tag: WS_METHODS.serverRunStorageCleanup,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    /** Lets a nightly copy of stable's state run its automation; the config stream clears the hold. */
    resumeAutomation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:resume-automation",
      tag: WS_METHODS.serverResumeAutomation,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    /** Runs that machine's history compaction now; Fleet offers it when storage is over budget. */
    compactStorage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:compact-storage",
      tag: WS_METHODS.serverCompactStorage,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    /** Stops the stray GOAT servers that machine's host status lists. */
    cleanUpStrayProcesses: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:clean-up-stray-processes",
      tag: WS_METHODS.serverCleanUpStrayProcesses,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    ...createStorageEnvironmentAtoms(runtime),
    databaseStorage,
    databaseCompactionRecommendations,
    storageCleanupReport: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:storage-cleanup-report",
      tag: WS_METHODS.serverGetStorageCleanupReport,
      idleTtlMs: 0,
    }),
    /** Rechecked whenever the setting changes, and on reopen after five seconds. */
    worktreesDirectoryStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:worktrees-directory-status",
      tag: WS_METHODS.serverGetWorktreesDirectoryStatus,
      idleTtlMs: 0,
      staleTimeMs: 5_000,
      refreshTrigger: ({ environmentId }) => worktreesDirectorySettingAtom(environmentId),
    }),
    /** Driver readiness on the host, refreshed by helper reports and the computer use setting. */
    computerUse: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:computer-use",
      tag: WS_METHODS.serverCheckComputerUse,
      idleTtlMs: 0,
      refreshTrigger: ({ environmentId }) => computerUseRefreshAtom(environmentId),
    }),
    /**
     * The host's running apps with names and icons (computerUse.apps), for the composer's @ list
     * and the icons beside computer use calls. Refreshes with the computer use readiness.
     */
    computerUseApps: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:computer-use-apps",
      tag: WS_METHODS.computerUseApps,
      idleTtlMs: 0,
      staleTimeMs: 15_000,
      refreshTrigger: ({ environmentId }) => computerUseRefreshAtom(environmentId),
    }),
    stageServerUpdate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:stage-update",
      tag: WS_METHODS.serverUpdateServer,
    }),
    updateStateAtom,
    settingsValueAtom,
    usageModelFilterAtom,
    providersValueAtom,
    providerAuthState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:provider:auth-state",
      tag: WS_METHODS.providerAuthSubscribe,
      idleTtlMs: 0,
    }),
    chatGptReconnectProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chatgpt:reconnect-profile",
      tag: WS_METHODS.chatGptReconnectProfile,
    }),
    chatGptImportProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chatgpt:import-profile",
      tag: WS_METHODS.chatGptImportProfile,
    }),
    chatGptHandoffState: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:chatgpt:handoff",
      sensitiveInput: true,
      // OAuth must not be replayed when the connection recovers.
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.chatGptHandoffSubscribe>) =>
        runStream(WS_METHODS.chatGptHandoffSubscribe, input),
      idleTtlMs: 0,
    }),
    codexAuthCallbackState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:codex:auth-callback",
      tag: WS_METHODS.codexAuthCallbackSubscribe,
      idleTtlMs: 0,
    }),
    providerInstallState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:provider:install-state",
      tag: WS_METHODS.providerInstallSubscribe,
      idleTtlMs: 0,
    }),
    startProviderInstall: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:install-start",
      tag: WS_METHODS.providerInstallStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    cancelProviderInstall: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:install-cancel",
      tag: WS_METHODS.providerInstallCancel,
    }),
    removeProviderInstallation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:install-remove",
      tag: WS_METHODS.providerInstallRemove,
    }),
    traceDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:trace-diagnostics",
      tag: WS_METHODS.serverGetTraceDiagnostics,
    }),
    processDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-diagnostics",
      tag: WS_METHODS.serverGetProcessDiagnostics,
    }),
    hostResources: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:server:host-resources",
      idleTtlMs: 0,
      staleTimeMs: 5_000,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.serverGetHostResources>) =>
        request(WS_METHODS.serverGetHostResources, input).pipe(Effect.timeout("5 seconds")),
    }),
    /**
     * This machine and connected SSH hosts; each silent host is cut off at 10s on the server.
     * Views refresh it on their own 15s period. The idle TTL covers that period, so a view or
     * derived atom that stops reading for a moment does not rebuild it and send an unplanned read.
     */
    hostStatus: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:server:host-status",
      idleTtlMs: 15_000,
      staleTimeMs: 5_000,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.serverGetHostStatus>) =>
        request(WS_METHODS.serverGetHostStatus, input).pipe(Effect.timeout("30 seconds")),
    }),
    processResourceHistory: createEnvironmentRpcQueryAtomFamily(
      runtime,
      processResourceHistoryOptions,
    ),
    remoteLaunches,
    /** Stops following a launch whose host no longer answers; the list then shows it dismissed. */
    dismissRemoteLaunch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:dismiss-remote-launch",
      tag: REMOTE_LAUNCHES_WS_METHODS.dismiss,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(remoteLaunches({ environmentId, input: {} }))),
    }),
    ...createDecisionEnvironmentAtoms(runtime),
    ...createProviderAuthCommands(runtime),
    ...createHubDeviceCommands(runtime),
    /** Asks this machine's managed OpenCodex update to check now, from the update dialog. */
    checkOpenCodexUpdate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:check-opencodex-update",
      tag: WS_METHODS.serverCheckOpenCodexUpdate,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    scheduledTaskWebhookDeliveries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:scheduled-task:webhook-deliveries",
      tag: WS_METHODS.scheduledTasksListWebhookDeliveries,
    }),
    scheduledTaskWebhookDelivery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:scheduled-task:webhook-delivery",
      tag: WS_METHODS.scheduledTasksGetWebhookDelivery,
    }),
    ...createHubMachinesAtoms(runtime),
    hubNodesLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:hub-nodes:live",
      tag: WS_METHODS.hubNodesSubscribe,
    }),
    scheduledTasksLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:scheduled-tasks:live",
      tag: WS_METHODS.scheduledTasksSubscribe,
    }),
    // A cold transcript scan is measured in seconds, so keep the result around
    // long enough that switching windows or re-rendering does not rescan.
    usageSummary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:usage-summary",
      tag: WS_METHODS.serverGetUsageSummary,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => usageScanSettingsAtom(environmentId),
      execute: readUsageSummary,
    }),
    resourceTelemetry: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry",
      tag: WS_METHODS.subscribeResourceTelemetry,
      idleTtlMs: 0,
    }),
    resourceTelemetryHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry-history",
      tag: WS_METHODS.serverGetResourceTelemetryHistory,
      staleTimeMs: 5_000,
      refreshIntervalMs: 5_000,
      idleTtlMs: 0,
    }),
    searchAcpRegistry: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:acp-registry:search",
      tag: WS_METHODS.serverSearchAcpRegistry,
      // Reopening Add provider reuses recent results. Submitting the same search asks the
      // server again, which reuses a Registry index fetched in the last five minutes.
      staleTimeMs: 5 * 60_000,
    }),
    configProjection,
    welcome,
    updateOutcome: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:update-outcome",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.filterMap((event) =>
            event.type === "ready" && event.payload.updateOutcome !== undefined
              ? Result.succeed(event.payload.updateOutcome)
              : Result.failVoid,
          ),
        ),
    }),
    legacyThreadMigration: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:legacy-thread-migration",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.filterMap((event) =>
            event.type === "legacyThreadMigration"
              ? Result.succeed(event.payload)
              : Result.failVoid,
          ),
        ),
    }),
    /** Replacement drains. Subscribe with `{ runtimeDrain: true }`; older servers send none. */
    runtimeDrain: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:runtime-drain",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.filterMap((event) =>
            event.type === "runtimeDrain" ? Result.succeed(event.payload) : Result.failVoid,
          ),
        ),
    }),
    consumeResetCredit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:consume-reset-credit",
      tag: WS_METHODS.providerConsumeResetCredit,
      concurrency: {
        mode: "singleFlight",
        // Both ids are free-form strings; a delimiter could collide.
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    refreshProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-providers",
      tag: WS_METHODS.serverRefreshProviders,
      onStart: ({ environmentId, input }, registry) =>
        input.cwd === undefined
          ? undefined
          : registry
              .get(configValueAtom(environmentId))
              ?.providers.find((provider) => provider.instanceId === input.instanceId),
      execute: (input, registry, environmentId) => {
        const provider =
          input.cwd === undefined
            ? undefined
            : registry
                .get(configValueAtom(environmentId))
                ?.providers.find((candidate) => candidate.instanceId === input.instanceId);
        return requestGuarded(WS_METHODS.serverRefreshProviders, {
          ...input,
          workspaceSnapshotsOnDemand: true,
          ...(options.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
          ...(options.providerCatalogsOnDemand === true ? { providerCatalogsOnDemand: true } : {}),
          ...(provider?.catalogDigest !== undefined &&
          provider.loadedCatalogDigest !== provider.catalogDigest
            ? { machineCatalog: true }
            : {}),
        });
      },
      onSuccess: ({ environmentId, input }, registry, result, configProvider) =>
        Effect.sync(() => {
          const { instanceId, cwd } = input;
          if (instanceId === undefined || cwd === undefined) return;
          const refreshed = result.providers.find((provider) => provider.instanceId === instanceId);
          if (refreshed?.catalogDigest !== undefined) {
            const catalog: FetchedMachineCatalog = {
              instanceId,
              digest: refreshed.catalogDigest,
              slashCommands: refreshed.slashCommands,
              skills: refreshed.skills,
            };
            registry.update(fetchedMachineCatalogsAtom(environmentId), (current) => [
              ...current.filter((entry) => entry.instanceId !== instanceId),
              catalog,
            ]);
          }
          registry.update(fetchedWorkspaceSnapshotsAtom(environmentId), (current) =>
            recordFetchedWorkspaceSnapshot(
              current,
              { instanceId, cwd, fresh: input.fresh === true },
              result.providers,
              configProvider,
            ),
          );
        }),
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.instanceId ?? null,
            input.cwd ?? null,
            input.fresh ?? false,
            input.refreshModels ?? false,
            input.modelCatalogOnly ?? false,
            input.omitProviders ?? false,
          ]),
      },
    }),
    updateProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-provider",
      tag: WS_METHODS.serverUpdateProvider,
    }),
    updateServer,
    upsertKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:upsert-keybinding",
      tag: WS_METHODS.serverUpsertKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    removeKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-keybinding",
      tag: WS_METHODS.serverRemoveKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateSettings,
    removeComputerUseAllowedApp: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-computer-use-app",
      tag: WS_METHODS.computerUseRemoveAllowedApp,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    mutateProviderInstance: updateSettings,
    prepareAcpRegistryAgent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:prepare",
      tag: WS_METHODS.serverPrepareAcpRegistryAgent,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.agentId}`,
      },
    }),
    uninstallAcpRegistryManagedBinary: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:uninstall-managed-binary",
      tag: WS_METHODS.serverUninstallAcpRegistryManagedBinary,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.agentId}`,
      },
    }),
    acceptAcpRegistryUrlAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:accept-url-auth",
      tag: WS_METHODS.serverAcceptAcpRegistryUrlAuth,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.elicitationId}`,
      },
    }),
    listAcpRegistrySessions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:list-sessions",
      tag: WS_METHODS.serverListAcpRegistrySessions,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.continuation ?? input.cursor ?? "first"}`,
      },
    }),
    importAcpRegistrySession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:import-session",
      tag: WS_METHODS.serverImportAcpRegistrySession,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.sessionId}`,
      },
    }),
    deleteAcpRegistrySession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:delete-session",
      tag: WS_METHODS.serverDeleteAcpRegistrySession,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.sessionId}`,
      },
    }),
    listAcpRegistryProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:list-providers",
      tag: WS_METHODS.serverListAcpRegistryProviders,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}`,
      },
    }),
    setAcpRegistryProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:set-provider",
      tag: WS_METHODS.serverSetAcpRegistryProvider,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.providerId}`,
      },
    }),
    disableAcpRegistryProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:disable-provider",
      tag: WS_METHODS.serverDisableAcpRegistryProvider,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.providerId}`,
      },
    }),
    logoutAcpRegistry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:logout",
      tag: WS_METHODS.serverLogoutAcpRegistry,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.instanceId}`,
      },
    }),
    signalProcess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:signal-process",
      tag: WS_METHODS.serverSignalProcess,
    }),
    addHubNode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:hub-nodes:add",
      tag: WS_METHODS.hubNodesAdd,
    }),
    importHubNodes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:hub-nodes:import",
      tag: WS_METHODS.hubNodesImport,
    }),
    removeHubNode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:hub-nodes:remove",
      tag: WS_METHODS.hubNodesRemove,
    }),
    checkHubNodes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:hub-nodes:check",
      tag: WS_METHODS.hubNodesCheck,
    }),
    dismissHubNodeNotice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:hub-nodes:dismiss-notice",
      tag: WS_METHODS.hubNodesDismissNotice,
    }),
    upsertScheduledTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:upsert",
      tag: WS_METHODS.scheduledTasksUpsert,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    setScheduledTaskEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:set-enabled",
      tag: WS_METHODS.scheduledTasksSetEnabled,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    deleteScheduledTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:delete",
      tag: WS_METHODS.scheduledTasksDelete,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    // Deliberately not on the config lane: run-now blocks until the run is
    // dispatched, and a slow run must not stall settings/keybinding/provider
    // mutations (or other scheduled-task edits) queued behind it.
    runScheduledTaskNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:run-now",
      tag: WS_METHODS.scheduledTasksRunNow,
    }),
    rotateScheduledTaskWebhookToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:rotate-webhook-token",
      tag: WS_METHODS.scheduledTasksRotateWebhookToken,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    // Waiting on an SSH host must not occupy the settings config lane.
    preflightSshHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh:preflightSshHost",
      tag: WS_METHODS.sshHostPreflight,
    }),
    probeSshHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh:probeSshHost",
      tag: WS_METHODS.sshHostProbe,
    }),
    trustSshHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh:trustSshHost",
      tag: WS_METHODS.sshHostTrust,
    }),
    prepareSshHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh:prepareSshHost",
      tag: WS_METHODS.sshHostPrepare,
    }),
    forgetSshHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ssh:forgetSshHost",
      tag: WS_METHODS.sshHostForget,
    }),
    createGuestShare: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:guest-share:create",
      tag: WS_METHODS.guestShareCreate,
    }),
    // Off the config lane: answering a card must not queue behind settings
    // edits. One answer per card at a time.
    openHandoff: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:handoff:open",
      tag: WS_METHODS.handoffsOpen,
    }),
    respondHandoff: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:handoff:respond",
      tag: WS_METHODS.handoffsRespond,
    }),
    answerSecretRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:secrets:answer-request",
      tag: WS_METHODS.secretsAnswerRequest,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.turnItemId]),
      },
    }),
    refreshUsageRates: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-usage-rates",
      tag: WS_METHODS.serverRefreshUsageRates,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    checkOtlpEndpoint: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:check-otlp-endpoint",
      tag: WS_METHODS.serverCheckOtlpEndpoint,
    }),
    checkSecretSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:check-secret-source",
      tag: WS_METHODS.serverCheckSecretSource,
    }),
    retryResourceTelemetry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:retry-resource-telemetry",
      tag: WS_METHODS.serverRetryResourceTelemetry,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
