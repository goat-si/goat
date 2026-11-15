import { normalizeCodexThreadLoadModelSelection } from "../Adapters/CodexCapabilities.ts";
import {
  makeProviderSession,
  type TestProviderRuntimeState,
  CODEX_DRIVER,
} from "../ProviderSessionFixture.testkit.ts";
import * as AdapterInfrastructure from "../../provider/ProviderOrchestrationAdapterInfrastructure.ts";
import * as NetAddress from "effect/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  ProviderInstanceId,
  ProviderSessionId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "../ProviderEventIngestor.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as CuaDriver from "../../cua/CuaDriver.ts";
import * as ComputerUseTestkit from "../../cua/ComputerUseLeases.testkit.ts";
import * as CommandOutputHub from "../CommandOutputHub.ts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  layerTestStores,
  layerTestEventSink,
  layerFailingReleaseEventSink,
  type FlakyReleaseWrites,
  layerFlakyReleaseEventSink,
  layerPausingAttachEventSink,
  layerBeforeUnchangedWriteEventSink,
} from "../ProviderSessionManager.persistence.testkit.ts";
const CodexCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
function unimplemented(detail: string) {
  return Effect.fail(
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CODEX_DRIVER,
      detail,
    }),
  );
}
const makeProviderAdapter = Effect.fnUntraced(function* (
  state: Ref.Ref<TestProviderRuntimeState>,
  options: {
    readonly normalizeCodexLoad?: boolean;
    readonly failEventStream?: boolean;
    readonly capabilities?: OrchestrationV2ProviderCapabilities;
    readonly extensionStatuses?: OrchestrationV2ProviderSession["extensionStatuses"];
    readonly mcpConfigs?: Ref.Ref<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >;
    readonly beforeOpen?: (input: {
      readonly providerSessionId: ProviderSessionId;
      readonly initialProviderItemIdentityVersion?: 2;
    }) => Effect.Effect<void>;
    readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
    readonly hasPendingBackgroundWorkForThread?: Effect.Effect<boolean>;
    readonly backgroundTasksEndWithProcess?: boolean;
    readonly hangSessionScopeClose?: boolean;
    readonly onTurnInput?: (
      input: ProviderAdapter.ProviderAdapterV2TurnInput,
    ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterTurnStartError>;
    readonly startTurn?: Effect.Effect<void>;
    readonly resumeTurn?: Effect.Effect<void>;
    readonly interruptTurn?: Effect.Effect<void>;
    readonly beforeUnload?: Effect.Effect<void>;
    readonly unloads?: Queue.Queue<string>;
    readonly archive?: Effect.Effect<void, ProviderAdapter.ProviderAdapterProtocolError>;
    readonly spawnBeforeOpen?: boolean;
    readonly scopeCloseReached?: Deferred.Deferred<void>;
  } = {},
) {
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const countClose = Effect.addFinalizer(() =>
    Ref.update(state, (current) => ({
      ...current,
      closeCount: current.closeCount + 1,
    })).pipe(
      Effect.andThen(
        options.unloads === undefined ? Effect.void : Queue.offer(options.unloads, "close"),
      ),
    ),
  );
  // Register after countClose to wedge teardown before its finalizer, matching a provider stream that never yields.
  const hangClose = Effect.addFinalizer(() =>
    (options.scopeCloseReached === undefined
      ? Effect.void
      : Deferred.succeed(options.scopeCloseReached, undefined)
    ).pipe(Effect.andThen(Effect.never)),
  );
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: ProviderInstanceId.make("codex"),
    driver: CODEX_DRIVER,
    getCapabilities: () => Effect.succeed(options.capabilities ?? CodexCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        if (options.spawnBeforeOpen === true) {
          yield* countClose;
          if (options.hangSessionScopeClose === true) yield* hangClose;
        }
        if (options.mcpConfigs !== undefined && options.spawnBeforeOpen === true) {
          const mcpConfig = yield* mcpSessions.read(input.threadId);
          yield* Ref.update(options.mcpConfigs, (configs) => [...configs, mcpConfig]);
        }
        if (options.beforeOpen !== undefined) {
          yield* options.beforeOpen(input);
        }
        if (options.mcpConfigs !== undefined && options.spawnBeforeOpen !== true) {
          const mcpConfig = yield* mcpSessions.read(input.threadId);
          yield* Ref.update(options.mcpConfigs, (configs) => [...configs, mcpConfig]);
        }
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
        let session: OrchestrationV2ProviderSession = {
          ...makeProviderSession({
            providerSessionId: input.providerSessionId,
            now,
            ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
          }),
          ...(options.extensionStatuses === undefined
            ? {}
            : { extensionStatuses: options.extensionStatuses }),
        };
        yield* Ref.update(state, (current) => {
          const eventQueues = new Map(current.eventQueues);
          eventQueues.set(String(input.providerSessionId), events);
          return {
            ...current,
            openCount: current.openCount + 1,
            eventQueues,
          };
        });
        if (options.spawnBeforeOpen !== true) {
          yield* countClose;
          if (options.hangSessionScopeClose === true) yield* hangClose;
        }
        return {
          instanceId: ProviderInstanceId.make("codex"),
          driver: CODEX_DRIVER,
          providerSessionId: input.providerSessionId,
          get providerSession() {
            return session;
          },
          events: options.failEventStream
            ? Stream.fail(
                new ProviderAdapter.ProviderAdapterEventStreamError({
                  driver: CODEX_DRIVER,
                  providerSessionId: input.providerSessionId,
                  cause: "process exited",
                }),
              )
            : Stream.fromQueue(events).pipe(
                Stream.tap((event) =>
                  Effect.sync(() => {
                    if (event.type === "provider_session.updated") session = event.providerSession;
                  }),
                ),
              ),
          ...(options.backgroundTasksEndWithProcess === false
            ? {}
            : { backgroundTasksEndWithProcess: true as const }),
          ...(options.hasPendingBackgroundWork === undefined
            ? {}
            : { hasPendingBackgroundWork: options.hasPendingBackgroundWork }),
          ...(options.hasPendingBackgroundWorkForThread === undefined
            ? {}
            : {
                hasPendingBackgroundWorkForThread: () => options.hasPendingBackgroundWorkForThread!,
              }),
          ...(options.normalizeCodexLoad
            ? {
                normalizeThreadLoadModelSelection: normalizeCodexThreadLoadModelSelection,
              }
            : {}),
          ensureThread: () => unimplemented("ensureThread unused in test"),
          resumeThread: (threadInput) =>
            Ref.update(state, (current) => ({
              ...current,
              resumeCount: current.resumeCount + 1,
            })).pipe(Effect.as(threadInput.providerThread)),
          startTurn: (turnInput) =>
            options.onTurnInput?.(turnInput) ?? options.startTurn ?? Effect.void,
          ...(options.resumeTurn === undefined ? {} : { resumeTurn: () => options.resumeTurn! }),
          steerTurn: () => Effect.void,
          interruptTurn: () =>
            Ref.update(state, (current) => ({
              ...current,
              interruptCount: current.interruptCount + 1,
            })).pipe(Effect.andThen(options.interruptTurn ?? Effect.void)),
          unloadThread: ({ providerThread, archive }) =>
            (options.beforeUnload ?? Effect.void).pipe(
              Effect.andThen(
                Ref.update(state, (current) => ({
                  ...current,
                  unloadedNativeThreadIds: [
                    ...current.unloadedNativeThreadIds,
                    providerThread.nativeThreadRef?.nativeId ?? "",
                  ],
                })),
              ),
              Effect.andThen(
                options.unloads === undefined
                  ? Effect.void
                  : Queue.offer(
                      options.unloads,
                      `${archive === true ? "archive" : "unload"}:${providerThread.nativeThreadRef?.nativeId}`,
                    ),
              ),
              Effect.andThen(archive === true ? (options.archive ?? Effect.void) : Effect.void),
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused in test"),
          rollbackThread: () => unimplemented("rollbackThread unused in test"),
          forkThread: () => unimplemented("forkThread unused in test"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });
});
export function layerTest(input: {
  readonly normalizeCodexLoad?: boolean;
  readonly state: Ref.Ref<TestProviderRuntimeState>;
  readonly idleTimeoutMs: number;
  readonly maxIdlePinMs?: number;
  readonly beforeIdleFiberInterrupt?: Effect.Effect<void>;
  readonly failEventStream?: boolean;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly extensionStatuses?: OrchestrationV2ProviderSession["extensionStatuses"];
  readonly mcpConfigs?: Ref.Ref<
    ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
  >;
  readonly beforeOpen?: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly initialProviderItemIdentityVersion?: 2;
  }) => Effect.Effect<void>;
  readonly failReleaseEventWrites?: boolean;
  readonly flakyReleaseWrites?: FlakyReleaseWrites;
  readonly pauseAttachWrite?: Parameters<typeof layerPausingAttachEventSink>[0];
  readonly beforeUnchangedWrite?: Ref.Ref<Effect.Effect<void>>;
  readonly beforeTurnItemsWrite?: Ref.Ref<ReadonlyArray<Effect.Effect<void>>>;
  readonly pauseResolve?: {
    readonly armed: Ref.Ref<boolean>;
    readonly paused: Deferred.Deferred<void>;
  };
  readonly registryOptions?: McpSessionRegistry.McpSessionRegistryOptions;
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  readonly hasPendingBackgroundWorkForThread?: Effect.Effect<boolean>;
  readonly backgroundTasksEndWithProcess?: boolean;
  readonly hangSessionScopeClose?: boolean;
  readonly onTurnInput?: (
    input: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterTurnStartError>;
  readonly startTurn?: Effect.Effect<void>;
  readonly resumeTurn?: Effect.Effect<void>;
  readonly interruptTurn?: Effect.Effect<void>;
  readonly beforeUnload?: Effect.Effect<void>;
  readonly unloads?: Queue.Queue<string>;
  readonly archive?: Effect.Effect<void, ProviderAdapter.ProviderAdapterProtocolError>;
  readonly spawnBeforeOpen?: boolean;
  readonly scopeCloseReached?: Deferred.Deferred<void>;
  readonly serverSettingsLayer?: ReturnType<typeof ServerSettings.layerTest>;
  readonly projectServiceLayer?: Layer.Layer<ProjectService.ProjectService>;
  readonly cuaDriverLayer?: Layer.Layer<CuaDriver.CuaDriver | ComputerUseTestkit.Leases>;
  readonly projectionReads?: { getThread: number; getThreadShell: number };
  readonly beforeGetThread?: Ref.Ref<Effect.Effect<void>>;
  readonly fileSystem?: FileSystem.FileSystem;
}) {
  const reads = input.projectionReads ?? { getThread: 0, getThreadShell: 0 };
  const beforeGetThread = input.beforeGetThread;
  const layerConfiguredStores =
    input.projectionReads || beforeGetThread
      ? Layer.merge(
          layerTestStores,
          Layer.effect(
            ProjectionStore.ProjectionStoreV2,
            Effect.gen(function* () {
              const delegate = yield* ProjectionStore.ProjectionStoreV2;
              return ProjectionStore.ProjectionStoreV2.of({
                ...delegate,
                getThread: (threadId) =>
                  Effect.sync(() => reads.getThread++).pipe(
                    Effect.andThen(
                      beforeGetThread ? Effect.flatten(Ref.get(beforeGetThread)) : Effect.void,
                    ),
                    Effect.andThen(delegate.getThread(threadId)),
                  ),
                getThreadShell: (threadId) =>
                  Effect.sync(() => reads.getThreadShell++).pipe(
                    Effect.andThen(delegate.getThreadShell(threadId)),
                  ),
              });
            }),
          ).pipe(Layer.provide(layerTestStores)),
        )
      : layerTestStores;
  const layerConfiguredEventSink =
    input.flakyReleaseWrites !== undefined
      ? layerFlakyReleaseEventSink(input.flakyReleaseWrites)
      : input.pauseAttachWrite !== undefined
        ? layerPausingAttachEventSink(input.pauseAttachWrite)
        : input.beforeUnchangedWrite !== undefined
          ? layerBeforeUnchangedWriteEventSink(
              input.beforeUnchangedWrite,
              input.beforeTurnItemsWrite,
            )
          : input.failReleaseEventWrites
            ? layerFailingReleaseEventSink
            : layerTestEventSink;
  const layerRegistry = Layer.unwrap(
    makeProviderAdapter(input.state, {
      ...(input.normalizeCodexLoad ? { normalizeCodexLoad: true } : {}),
      failEventStream: input.failEventStream ?? false,
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      ...(input.extensionStatuses === undefined
        ? {}
        : { extensionStatuses: input.extensionStatuses }),
      ...(input.mcpConfigs === undefined ? {} : { mcpConfigs: input.mcpConfigs }),
      ...(input.beforeOpen === undefined ? {} : { beforeOpen: input.beforeOpen }),
      ...(input.hasPendingBackgroundWork === undefined
        ? {}
        : { hasPendingBackgroundWork: input.hasPendingBackgroundWork }),
      ...(input.hasPendingBackgroundWorkForThread === undefined
        ? {}
        : { hasPendingBackgroundWorkForThread: input.hasPendingBackgroundWorkForThread }),
      ...(input.backgroundTasksEndWithProcess === undefined
        ? {}
        : { backgroundTasksEndWithProcess: input.backgroundTasksEndWithProcess }),
      ...(input.hangSessionScopeClose === undefined
        ? {}
        : { hangSessionScopeClose: input.hangSessionScopeClose }),
      ...(input.onTurnInput === undefined ? {} : { onTurnInput: input.onTurnInput }),
      ...(input.startTurn === undefined ? {} : { startTurn: input.startTurn }),
      ...(input.resumeTurn === undefined ? {} : { resumeTurn: input.resumeTurn }),
      ...(input.interruptTurn === undefined ? {} : { interruptTurn: input.interruptTurn }),
      ...(input.beforeUnload === undefined ? {} : { beforeUnload: input.beforeUnload }),
      ...(input.unloads === undefined ? {} : { unloads: input.unloads }),
      ...(input.archive === undefined ? {} : { archive: input.archive }),
      ...(input.spawnBeforeOpen === undefined ? {} : { spawnBeforeOpen: input.spawnBeforeOpen }),
      ...(input.scopeCloseReached === undefined
        ? {}
        : { scopeCloseReached: input.scopeCloseReached }),
    }).pipe(Effect.map(ProviderAdapterRegistry.layerSingle)),
  );
  const layerConfiguredMcpRegistry =
    input.pauseResolve === undefined
      ? input.registryOptions === undefined
        ? layerTestMcpRegistry
        : layerTestMcpRegistryWithOptions(input.registryOptions)
      : layerPausingMcpRegistry(input.pauseResolve);
  const layerProviderEventIngestorTest = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          // @effect-diagnostics-next-line effectSucceedWithVoid:off - Optional instances require undefined rather than void.
          getInstance: () => Effect.succeed(undefined),
        }),
        layerConfiguredEventSink,
        IdAllocator.layer,
        layerConfiguredStores,
        ThreadCommandExecutor.layer,
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveBranchName: () => Effect.succeed(null),
        }),
      ),
    ),
  );
  return Layer.mergeAll(
    AdapterInfrastructure.layerMemoryAdmission,
    layerConfiguredStores,
    layerConfiguredEventSink,
    IdAllocator.layer,
    layerConfiguredMcpRegistry,
    McpProviderSessions.layer,
    ProviderSessionManager.layerWithOptions({
      idleTimeoutMs: input.idleTimeoutMs,
      ...(input.maxIdlePinMs === undefined ? {} : { maxIdlePinMs: input.maxIdlePinMs }),
      ...(input.beforeIdleFiberInterrupt === undefined
        ? {}
        : { beforeIdleFiberInterrupt: input.beforeIdleFiberInterrupt }),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          layerRegistry.pipe(Layer.provideMerge(McpProviderSessions.layer)),
          AdapterInfrastructure.layerMemoryAdmission,
          CommandOutputHub.layer.pipe(
            Layer.provide(Layer.merge(layerConfiguredEventSink, layerTestStores)),
          ),
          layerConfiguredEventSink,
          IdAllocator.layer,
          layerProviderEventIngestorTest,
          layerConfiguredMcpRegistry,
          layerConfiguredStores,
          ...(input.serverSettingsLayer === undefined ? [] : [input.serverSettingsLayer]),
          ...(input.projectServiceLayer === undefined ? [] : [input.projectServiceLayer]),
          ...(input.cuaDriverLayer === undefined ? [] : [input.cuaDriverLayer]),
        ),
      ),
    ),
  ).pipe(
    Layer.provide(
      input.fileSystem === undefined
        ? NodeServices.layer
        : Layer.merge(NodeServices.layer, Layer.succeed(FileSystem.FileSystem, input.fileSystem)),
    ),
  );
}
const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-provider-session-manager")),
  getDescriptor: Effect.die("unused"),
});
const layerTestMcpRegistryWithOptions = (options: McpSessionRegistry.McpSessionRegistryOptions) =>
  Layer.effect(
    McpSessionRegistry.McpSessionRegistry,
    McpSessionRegistry.__testing.make(options),
  ).pipe(
    Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
    Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
    Layer.provide(NodeServices.layer),
  );
const layerTestMcpRegistry = layerTestMcpRegistryWithOptions({});
const layerPausingMcpRegistry = (pause: {
  readonly armed: Ref.Ref<boolean>;
  readonly paused: Deferred.Deferred<void>;
}) =>
  Layer.effect(
    McpSessionRegistry.McpSessionRegistry,
    Effect.gen(function* () {
      const delegate = yield* McpSessionRegistry.McpSessionRegistry;
      return McpSessionRegistry.McpSessionRegistry.of({
        ...delegate,
        resolve: (rawToken) =>
          Ref.getAndSet(pause.armed, false).pipe(
            Effect.flatMap((armed) =>
              armed
                ? Deferred.succeed(pause.paused, undefined).pipe(Effect.andThen(Effect.never))
                : delegate.resolve(rawToken),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(layerTestMcpRegistry));

export { CodexCapabilities, fakeEnvironment, unimplemented };
