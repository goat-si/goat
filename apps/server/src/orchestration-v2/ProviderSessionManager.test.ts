import * as CodexRoutes from "../provider/CodexRouteService.ts";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import * as MemorySnapshot from "../memory/MemorySnapshot.ts";
import * as MemoryContext from "@goat/provider-core/server/memoryContext";
import * as MemoryContracts from "@goat/contracts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as RemoteReportInbox from "../remoteReports/RemoteReportInbox.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as AdapterInfrastructure from "../provider/ProviderOrchestrationAdapterInfrastructure.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ChannelDispatcher from "../channels/ChannelDispatcher.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ChannelLedger from "../channels/ChannelLedger.ts";
import * as ChannelRemoteWorkers from "../channels/ChannelRemoteWorkers.ts";
import * as SlackChannelSettings from "../channels/SlackChannelSettings.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as Path from "effect/Path";
import * as MemoryToolkitFixture from "../mcp/toolkits/memory/handlers.testkit.ts";
import * as NetAddress from "effect/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AgentScope } from "@goat/shared/AgentScope";
import {
  RunId,
  type OrchestrationV2Run,
  CommandId,
  MessageId,
  TurnItemId,
  ChannelTaskId,
  ChannelTaskEventId,
  ChannelQuestionId,
  EnvironmentId,
  CheckpointScopeId,
  ScheduledTaskId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Statement from "effect/sql/Statement";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/http";

import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
const layerFailingReleaseEventSink = Layer.effect(
  EventSink.EventSinkV2,
  Effect.gen(function* () {
    const delegate = yield* EventSink.EventSinkV2;
    return EventSink.EventSinkV2.of({
      ...delegate,
      write: (input) =>
        input.events.some(
          (event) =>
            event.type === "provider-session.updated" &&
            (event.payload.status === "stopped" || event.payload.status === "error"),
        )
          ? Effect.fail(new EventSink.EventSinkWriteError({ eventCount: input.events.length }))
          : delegate.write(input),
    });
  }),
).pipe(Layer.provide(layerTestEventSink));

interface FlakyReleaseWrites {
  readonly failing: Ref.Ref<"none" | "session" | "session-and-requests">;
  readonly failures: Queue.Queue<void>;
  readonly pauseRequestWrites?: {
    readonly paused: Deferred.Deferred<void>;
    readonly resume: Deferred.Deferred<void>;
  };
}

const layerFlakyReleaseEventSink = (flaky: FlakyReleaseWrites) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const failing = yield* Ref.get(flaky.failing);
            const fails = input.events.some(
              (event) =>
                (failing !== "none" &&
                  event.type === "provider-session.updated" &&
                  (event.payload.status === "stopped" || event.payload.status === "error")) ||
                (failing === "session-and-requests" && event.type === "runtime-request.updated"),
            );
            const pause = flaky.pauseRequestWrites;
            if (
              pause !== undefined &&
              input.events.some((event) => event.type === "runtime-request.updated")
            ) {
              yield* Deferred.succeed(pause.paused, undefined);
              yield* Deferred.await(pause.resume);
            }
            if (!fails) return yield* delegate.write(input);
            yield* Queue.offer(flaky.failures, undefined);
            return yield* Effect.die(new Error("simulated commit failure"));
          }),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const layerPausingAttachEventSink = (pause: {
  readonly armed: Ref.Ref<boolean>;
  readonly paused: Deferred.Deferred<void>;
}) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const attach = input.events.some((event) => event.type === "provider-session.attached");
            if (attach && (yield* Ref.getAndSet(pause.armed, false))) {
              yield* Deferred.succeed(pause.paused, undefined);
              return yield* Effect.never;
            }
            return yield* delegate.write(input);
          }),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const layerBeforeUnchangedWriteEventSink = (before: Ref.Ref<Effect.Effect<void>>) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        writeIfProviderThreadUnchanged: (input) =>
          Ref.getAndSet(before, Effect.void).pipe(
            Effect.flatten,
            Effect.andThen(delegate.writeIfProviderThreadUnchanged(input)),
          ),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

const CodexCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
const ExclusiveCapabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexCapabilities,
  sessions: {
    ...CodexCapabilities.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

interface TestProviderRuntimeState {
  readonly openCount: number;
  readonly closeCount: number;
  readonly interruptCount: number;
  readonly resumeCount: number;
  readonly unloadedNativeThreadIds: ReadonlyArray<string>;
  readonly eventQueues: ReadonlyMap<
    string,
    Queue.Queue<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>
  >;
}

const emptyState: TestProviderRuntimeState = {
  openCount: 0,
  closeCount: 0,
  interruptCount: 0,
  resumeCount: 0,
  unloadedNativeThreadIds: [],
  eventQueues: new Map(),
};

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;

function makeProviderSession(input: {
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    status: "ready",
    cwd: process.cwd(),
    model: "gpt-5.4",
    capabilities: input.capabilities ?? CodexCapabilities,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function makeThreadCreatedEvent(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly projectId?: ProjectId;
}) {
  return Effect.gen(function* () {
    const projectId =
      input.projectId ??
      (yield* input.idAllocator.allocate.project({
        fixtureName: "provider-session-manager",
      }));
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId,
      title: "Provider session manager",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return {
      id: yield* input.idAllocator.allocate.event({ threadId: input.threadId }),
      type: "thread.created" as const,
      threadId: input.threadId,
      occurredAt: input.now,
      payload: thread,
    };
  });
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly nativeThreadId?: string;
}): OrchestrationV2ProviderThread {
  const nativeThreadId = input.nativeThreadId ?? "native-thread";
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId,
    }),
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CODEX_DRIVER,
      nativeId: nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

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
    readonly failEventStream?: boolean;
    readonly capabilities?: OrchestrationV2ProviderCapabilities;
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
    readonly beforeUnload?: Effect.Effect<void>;
    readonly spawnBeforeOpen?: boolean;
    readonly scopeCloseReached?: Deferred.Deferred<void>;
  } = {},
) {
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const countClose = Effect.addFinalizer(() =>
    Ref.update(state, (current) => ({
      ...current,
      closeCount: current.closeCount + 1,
    })),
  );
  // Registered after countClose so it runs first on scope close, wedging the
  // close before the closeCount finalizer, like a provider process that never
  // yields its message stream.
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
        const session = makeProviderSession({
          providerSessionId: input.providerSessionId,
          now,
          ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        });
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
          providerSession: session,
          events: options.failEventStream
            ? Stream.fail(
                new ProviderAdapter.ProviderAdapterEventStreamError({
                  driver: CODEX_DRIVER,
                  providerSessionId: input.providerSessionId,
                  cause: "process exited",
                }),
              )
            : Stream.fromQueue(events),
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
            })),
          unloadThread: ({ providerThread }) =>
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
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused in test"),
          rollbackThread: () => unimplemented("rollbackThread unused in test"),
          forkThread: () => unimplemented("forkThread unused in test"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });
});

function layerTest(input: {
  readonly state: Ref.Ref<TestProviderRuntimeState>;
  readonly idleTimeoutMs: number;
  readonly maxIdlePinMs?: number;
  readonly beforeIdleFiberInterrupt?: Effect.Effect<void>;
  readonly failEventStream?: boolean;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
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
  readonly beforeUnload?: Effect.Effect<void>;
  readonly spawnBeforeOpen?: boolean;
  readonly scopeCloseReached?: Deferred.Deferred<void>;
  readonly serverSettingsLayer?: ReturnType<typeof ServerSettings.layerTest>;
  readonly projectServiceLayer?: Layer.Layer<ProjectService.ProjectService>;
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
          ? layerBeforeUnchangedWriteEventSink(input.beforeUnchangedWrite)
          : input.failReleaseEventWrites
            ? layerFailingReleaseEventSink
            : layerTestEventSink;
  const layerRegistry = Layer.unwrap(
    makeProviderAdapter(input.state, {
      failEventStream: input.failEventStream ?? false,
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
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
      ...(input.beforeUnload === undefined ? {} : { beforeUnload: input.beforeUnload }),
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

function makeBrowserAccessProject(projectId: ProjectId): Project {
  return {
    id: projectId,
    title: "Browser access project",
    workspaceRoot: process.cwd(),
    repositoryIdentity: null,
    faviconPath: null,
    projectIcon: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function runBrowserAccessScenario(input: {
  readonly enableAgentBrowserAccess: boolean;
  readonly projectOverride: boolean;
  readonly deviceOverride?: boolean;
  readonly createThread?: boolean;
  readonly projectExists?: boolean;
}) {
  return Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const projectId = ProjectId.make("project-provider-session-manager-browser-access");
    const threadId = ThreadId.make("thread-provider-session-manager-browser-access");
    const layerProjectService = Layer.mock(ProjectService.ProjectService)({
      getById: (requestedProjectId) =>
        Effect.succeed(
          input.projectExists === false
            ? Option.none()
            : Option.some(makeBrowserAccessProject(requestedProjectId)),
        ),
    });

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      if (input.createThread !== false) {
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now, projectId })],
        });
      }
      yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.ignore);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          projectServiceLayer: layerProjectService,
          serverSettingsLayer: ServerSettings.layerTest({
            enableAgentBrowserAccess: input.enableAgentBrowserAccess,
            projectSettingsOverrides: {
              [projectId]: {
                enableAgentBrowserAccess: input.projectOverride,
                ...(input.deviceOverride === undefined
                  ? {}
                  : { enableAgentDeviceAccess: input.deviceOverride }),
              },
            },
          }),
        }),
      ),
    );

    return (yield* Ref.get(mcpConfigs))[0];
  });
}

function makePendingRuntimeRequestEvents(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}) {
  return Effect.gen(function* () {
    const requestId = yield* input.idAllocator.allocate.runtimeRequest({
      driver: CODEX_DRIVER,
      nativeRequestId: "pending-approval",
    });
    const nodeId = input.idAllocator.derive.approvalNode({ requestId });
    const node = {
      id: nodeId,
      threadId: input.threadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "approval_request" as const,
      status: "waiting" as const,
      countsForRun: false,
      providerThreadId: input.providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: input.now,
      completedAt: null,
    };
    const request = {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: {
        driver: CODEX_DRIVER,
        nativeId: "pending-approval",
        strength: "strong" as const,
      },
      kind: "command" as const,
      status: "pending" as const,
      responseCapability: {
        type: "live" as const,
        providerSessionId: input.providerSessionId,
      },
      createdAt: input.now,
      resolvedAt: null,
    };
    const turnItem = {
      id: input.idAllocator.derive.approvalTurnItem({ requestId }),
      threadId: input.threadId,
      runId: null,
      nodeId,
      providerThreadId: input.providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "waiting" as const,
      title: null,
      startedAt: input.now,
      completedAt: null,
      updatedAt: input.now,
      type: "approval_request" as const,
      requestId,
      requestKind: "command" as const,
    };
    const events = [
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "node.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: node,
      },
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "runtime-request.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: request,
      },
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "turn-item.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: turnItem,
      },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
    const providerEvents = [
      {
        type: "runtime_request.updated" as const,
        driver: CODEX_DRIVER,
        threadId: input.threadId,
        runtimeRequest: request,
      },
      {
        type: "node.updated" as const,
        driver: CODEX_DRIVER,
        node,
      },
      {
        type: "turn_item.updated" as const,
        driver: CODEX_DRIVER,
        turnItem,
      },
    ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
    return { events, providerEvents, requestId, nodeId };
  });
}

it.effect("ProviderSessionManagerV2 opens independent sessions concurrently", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const openStartedCount = yield* Ref.make(0);
    const firstOpenStarted = yield* Deferred.make<void>();
    const secondOpenStarted = yield* Deferred.make<void>();
    const releaseOpens = yield* Deferred.make<void>();
    const beforeOpen = () =>
      Effect.gen(function* () {
        const openNumber = yield* Ref.modify(openStartedCount, (count) => [count + 1, count + 1]);
        yield* Deferred.succeed(openNumber === 1 ? firstOpenStarted : secondOpenStarted, undefined);
        yield* Deferred.await(releaseOpens);
      });

    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-concurrent-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-concurrent-b");
      const firstProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      const secondProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: secondThreadId,
      });

      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
        ],
      });
      const firstFiber = yield* manager
        .open({
          threadId: firstThreadId,
          providerSessionId: firstProviderSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstOpenStarted);
      const secondFiber = yield* manager
        .open({
          threadId: secondThreadId,
          providerSessionId: secondProviderSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);

      yield* Deferred.await(secondOpenStarted);
      assert.equal(yield* Ref.get(openStartedCount), 2);
      yield* Deferred.succeed(releaseOpens, undefined);
      const [firstRuntime, secondRuntime] = yield* Effect.all([
        Fiber.join(firstFiber),
        Fiber.join(secondFiber),
      ]);
      assert.notStrictEqual(firstRuntime, secondRuntime);
      assert.equal((yield* Ref.get(state)).openCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 closes every live session for a provider instance", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-logout-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-logout-b");
      const firstProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      const secondProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: secondThreadId,
      });

      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
        ],
      });
      yield* manager.open({
        threadId: firstThreadId,
        providerSessionId: firstProviderSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({
        threadId: secondThreadId,
        providerSessionId: secondProviderSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* manager.closeInstance(modelSelection.instanceId);

      assert.isTrue(Option.isNone(yield* manager.get(firstProviderSessionId)));
      assert.isTrue(Option.isNone(yield* manager.get(secondProviderSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 opens a duplicate session only once", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const openStartedCount = yield* Ref.make(0);
    const firstOpenStarted = yield* Deferred.make<void>();
    const releaseOpen = yield* Deferred.make<void>();
    const beforeOpen = () =>
      Ref.updateAndGet(openStartedCount, (count) => count + 1).pipe(
        Effect.tap(() => Deferred.succeed(firstOpenStarted, undefined)),
        Effect.andThen(Deferred.await(releaseOpen)),
      );

    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-single-flight");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const open = manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const firstFiber = yield* open.pipe(Effect.forkScoped);
      yield* Deferred.await(firstOpenStarted);
      const secondFiber = yield* open.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(openStartedCount), 1);

      yield* Deferred.succeed(releaseOpen, undefined);
      const [firstRuntime, secondRuntime] = yield* Effect.all([
        Fiber.join(firstFiber),
        Fiber.join(secondFiber),
      ]);
      assert.strictEqual(firstRuntime, secondRuntime);
      assert.equal((yield* Ref.get(state)).openCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 starts a thread's session without its last agent's OOM kill",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const owner = ThreadId.make("thread-provider-session-manager-oom-owner");
      const joiner = ThreadId.make("thread-provider-session-manager-oom-joiner");
      const oomKilledThreads = new Set<string>([owner, joiner]);
      const agentScope = {
        ...AgentScope.defaultValue(),
        oomKilled: (id: string) => Effect.sync(() => oomKilledThreads.has(id)),
        clear: (id: string) => Effect.sync(() => void oomKilledThreads.delete(id)),
      };

      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: owner,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: owner, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: joiner, now }),
          ],
        });
        yield* manager.open({ threadId: owner, providerSessionId, modelSelection, runtimePolicy });
        assert.isFalse(yield* agentScope.oomKilled(owner));

        yield* manager.open({ threadId: joiner, providerSessionId, modelSelection, runtimePolicy });
        assert.isFalse(yield* agentScope.oomKilled(joiner));

        oomKilledThreads.add(owner);
        yield* manager.open({ threadId: owner, providerSessionId, modelSelection, runtimePolicy });
        assert.isTrue(yield* agentScope.oomKilled(owner));
        assert.equal((yield* Ref.get(state)).openCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })),
        Effect.provideService(AgentScope, agentScope),
      );
    }),
);

it.effect("ProviderSessionManagerV2 cleans up an open interrupted mid-handshake", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const handshakeStarted = yield* Deferred.make<void>();
    const holdHandshake = yield* Ref.make(true);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-interrupted-open");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });

      const opening = yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(handshakeStarted);
      const issued = (yield* Ref.get(mcpConfigs)).at(-1);
      const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(token);
      assert.isDefined(yield* registry.resolve(token!));

      yield* Fiber.interrupt(opening);

      assert.equal((yield* Ref.get(state)).closeCount, 1);
      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(yield* mcpSessions.read(threadId));
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));

      yield* Ref.set(holdHandshake, false);
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const replacement = (yield* Ref.get(mcpConfigs)).at(-1);
      const replacementToken = replacement?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(replacementToken);
      assert.notEqual(replacementToken, token);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.providerSessions.at(-1)?.status, "ready");

      yield* manager.close(providerSessionId);
      assert.isUndefined(yield* registry.resolve(replacementToken!));
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          mcpConfigs,
          beforeOpen: () =>
            Ref.get(holdHandshake).pipe(
              Effect.flatMap((hold) =>
                hold
                  ? Deferred.succeed(handshakeStarted, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.void,
              ),
            ),
          spawnBeforeOpen: true,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a shared session busy when another thread's start is stopped early",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const projectId = ProjectId.make("project-provider-session-manager-shared-stopped-start");
      const holdProjectRead = yield* Ref.make(false);
      const projectReadHeld = yield* Deferred.make<void>();
      const projectServiceLayer = Layer.mock(ProjectService.ProjectService)({
        getById: (requestedProjectId) =>
          Ref.get(holdProjectRead).pipe(
            Effect.flatMap((hold) =>
              hold
                ? Deferred.succeed(projectReadHeld, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(Option.some(makeBrowserAccessProject(requestedProjectId))),
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadA = ThreadId.make("thread-provider-session-manager-shared-stopped-a");
        const threadB = ThreadId.make("thread-provider-session-manager-shared-stopped-b");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadA, now, projectId }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadB, now, projectId }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: threadA,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: threadB,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const startTurn = (threadId: ThreadId) =>
          Effect.gen(function* () {
            const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
            return yield* runtime.startTurn({
              appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
              threadId,
              runId,
              runOrdinal: 1,
              providerTurnOrdinal: 1,
              attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
              rootNodeId: idAllocator.derive.rootNode({ runId }),
              providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
                text: "turn",
                attachments: [],
              },
              modelSelection,
              runtimePolicy,
            });
          });

        yield* startTurn(threadB);

        yield* manager.detach({ providerSessionId, threadId: threadA });
        yield* Ref.set(holdProjectRead, true);
        const startingA = yield* startTurn(threadA).pipe(Effect.forkChild);
        yield* Deferred.await(projectReadHeld);
        yield* Fiber.interrupt(startingA);

        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            projectServiceLayer,
            serverSettingsLayer: ServerSettings.layerTest({
              projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: true } },
            }),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a shared session busy when a stopped start still ends its turn",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      // A's adapter start installs its turn, then is stopped mid-request; like
      // OpenCode2, the adapter still ends that turn with turn.terminal later.
      const holdStart = yield* Ref.make(false);
      const startHeld = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadA = ThreadId.make("thread-provider-session-manager-stopped-ended-a");
        const threadB = ThreadId.make("thread-provider-session-manager-stopped-ended-b");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadA, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadB, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: threadA,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: threadB,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const providerThreadOf = (threadId: ThreadId) =>
          makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: `native-${threadId}`,
          });
        const startTurn = (threadId: ThreadId) =>
          Effect.gen(function* () {
            const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
            return yield* runtime.startTurn({
              appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
              threadId,
              runId,
              runOrdinal: 1,
              providerTurnOrdinal: 1,
              attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
              rootNodeId: idAllocator.derive.rootNode({ runId }),
              providerThread: providerThreadOf(threadId),
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
                text: "turn",
                attachments: [],
              },
              modelSelection,
              runtimePolicy,
            });
          });

        yield* startTurn(threadB);

        yield* Ref.set(holdStart, true);
        const startingA = yield* startTurn(threadA).pipe(Effect.forkChild);
        yield* Deferred.await(startHeld);
        yield* Fiber.interrupt(startingA);

        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: providerThreadOf(threadA).id,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: CODEX_DRIVER,
            nativeTurnId: "native-turn-stopped-a",
          }),
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });

        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            startTurn: Ref.get(holdStart).pipe(
              Effect.flatMap((hold) =>
                hold
                  ? Deferred.succeed(startHeld, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.void,
              ),
            ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 stops a session still opening when its layer shuts down", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const handshakeStarted = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown-during-open");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.forkDetach);
      yield* Deferred.await(handshakeStarted);
      assert.equal((yield* Ref.get(state)).closeCount, 0);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen: () =>
            Deferred.succeed(handshakeStarted, undefined).pipe(Effect.andThen(Effect.never)),
          spawnBeforeOpen: true,
        }),
      ),
    );

    assert.equal((yield* Ref.get(state)).closeCount, 1);
  }),
);

it.effect("ProviderSessionManagerV2 interrupts event subscriptions on server shutdown", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown-subscription");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const bufferedSubscription = yield* runtime.subscribeEvents!;
      const activeSubscription = yield* runtime.subscribeEvents!;
      const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterQueue);
      yield* Queue.offer(adapterQueue!, {
        type: "provider_session.updated",
        driver: CODEX_DRIVER,
        providerSession: runtime.providerSession,
      });
      assert.isTrue(Option.isSome(yield* activeSubscription.events.pipe(Stream.runHead)));

      yield* manager.shutdown;

      const exit = yield* bufferedSubscription.events.pipe(Stream.runCollect, Effect.exit);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })));
  }),
);

it.effect("ProviderSessionManagerV2 drains subscribers when the provider stops", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-provider-stop");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const subscription = yield* runtime.subscribeEvents!;
      const collected = yield* subscription.events.pipe(Stream.runCollect, Effect.forkScoped);
      const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterQueue);
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "provider-stop-thread",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "provider-stop-turn",
      });
      yield* Queue.offer(adapterQueue!, {
        type: "turn.terminal",
        driver: CODEX_DRIVER,
        providerThreadId,
        providerTurnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Queue.offer(adapterQueue!, {
        type: "provider_session.updated",
        driver: CODEX_DRIVER,
        providerSession: {
          ...runtime.providerSession,
          status: "stopped",
          updatedAt: now,
        },
      });
      yield* Queue.end(adapterQueue!);

      const events = Array.from(yield* Fiber.join(collected));
      assert.deepEqual(
        events.map((event) => event.type),
        ["turn.terminal", "provider_session.updated"],
      );
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 issues MCP credentials before opening and revokes them on close",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-mcp");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const captured = (yield* Ref.get(mcpConfigs))[0];
        assert.isDefined(captured);
        assert.equal(captured?.threadId, threadId);
        assert.equal(captured?.providerInstanceId, modelSelection.instanceId);
        assert.equal(captured?.endpoint, "http://127.0.0.1:43123/mcp");
        const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);
        const resolved = yield* registry.resolve(token!);
        assert.equal(resolved?.thread.threadId, threadId);
        assert.deepEqual(
          resolved?.capabilities,
          new Set(["preview", "orchestration", "worktree", "pull-requests"]),
        );

        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* mcpSessions.read(threadId));
        assert.isUndefined(yield* registry.resolve(token!));
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 withholds the preview capability when agent browser access is off",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-no-browser");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const captured = (yield* Ref.get(mcpConfigs))[0];
        assert.isDefined(captured);
        assert.equal(captured?.browserToolsAvailable, false);
        const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
        const resolved = yield* registry.resolve(token!);
        assert.deepEqual(
          resolved?.capabilities,
          new Set(["orchestration", "worktree", "pull-requests"]),
        );

        yield* manager.close(providerSessionId);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            serverSettingsLayer: ServerSettings.layerTest({
              enableAgentBrowserAccess: false,
            }).pipe(Layer.orDie),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 honors a project browser-access opt-out", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.browserToolsAvailable, false);
  }),
);

it.effect("ProviderSessionManagerV2 fails browser access closed for a missing project", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: true,
      projectExists: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.browserToolsAvailable, false);
  }),
);

it.effect("ProviderSessionManagerV2 revokes MCP credentials when release persistence fails", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-mcp-release-failure");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      const captured = (yield* Ref.get(mcpConfigs))[0];
      const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(token);
      assert.isDefined(yield* registry.resolve(token!));

      const closeError = yield* manager.close(providerSessionId).pipe(Effect.flip);
      assert.equal(closeError._tag, "ProviderSessionCloseError");
      assert.isUndefined(yield* mcpSessions.read(threadId));
      assert.isUndefined(yield* registry.resolve(token!));
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          failReleaseEventWrites: true,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a thread attached when an earlier attach of it is interrupted",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const armed = yield* Ref.make(false);
      const paused = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const owner = ThreadId.make("thread-provider-session-manager-attach-race-owner");
        const threadId = ThreadId.make("thread-provider-session-manager-attach-race");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: owner, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: owner,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const resume = runtime.resumeThread({
          threadId,
          providerThread: makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: "native-attach-race",
          }),
        });

        yield* Ref.set(armed, true);
        const first = yield* resume.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(paused);
        const second = yield* resume.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        yield* Fiber.join(second);

        const config = yield* mcpSessions.read(threadId);
        assert.isDefined(config);
        const token = config!.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.equal((yield* registry.resolve(token))?.thread.threadId, threadId);
      }).pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, pauseAttachWrite: { armed, paused } }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a replacement session's attachment when a stale attach is interrupted",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const armed = yield* Ref.make(false);
      const paused = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const eventStore = yield* EventStore.EventStoreV2;
        const now = yield* DateTime.now;
        const owner = ThreadId.make("thread-provider-session-manager-stale-attach-owner");
        const threadId = ThreadId.make("thread-provider-session-manager-stale-attach");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: owner, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: owner,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        yield* Ref.set(armed, true);
        const stale = yield* runtime
          .resumeThread({
            threadId,
            providerThread: makeProviderThread({
              idAllocator,
              threadId,
              providerSessionId,
              now,
              nativeThreadId: "native-stale-attach",
            }),
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(paused);

        yield* manager.release({ providerSessionId, reason: "runtime_error" });
        const replacement = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const config = yield* mcpSessions.read(threadId);
        assert.isDefined(config);

        yield* Fiber.interrupt(stale);

        assert.equal(
          (yield* mcpSessions.read(threadId))?.providerSessionId,
          config!.providerSessionId,
        );
        const token = config!.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.equal((yield* registry.resolve(token))?.thread.threadId, threadId);
        const attachedEvents = eventStore
          .read({ threadId, eventType: "provider-session.attached" })
          .pipe(
            Stream.runCollect,
            Effect.map((events) => events.length),
          );
        const attachedBefore = yield* attachedEvents;
        yield* replacement.resumeThread({
          threadId,
          providerThread: makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: "native-stale-attach",
          }),
        });
        assert.equal(yield* attachedEvents, attachedBefore);
      }).pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, pauseAttachWrite: { armed, paused } }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 revokes a reused credential after a resume stopped while checking it",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const armed = yield* Ref.make(false);
      const paused = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const owner = ThreadId.make("thread-provider-session-manager-resolve-stop-owner");
        const threadId = ThreadId.make("thread-provider-session-manager-resolve-stop");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: owner, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: owner,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const resume = runtime.resumeThread({
          threadId,
          providerThread: makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: "native-resolve-stop",
          }),
        });
        yield* resume;
        yield* manager.detach({ providerSessionId, threadId });
        const config = yield* mcpSessions.read(threadId);
        assert.isDefined(config);
        const token = config!.authorizationHeader.replace(/^Bearer\s+/, "");

        yield* Ref.set(armed, true);
        const stopped = yield* resume.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(paused);
        yield* Fiber.interrupt(stopped);

        yield* manager.release({ providerSessionId, reason: "manual_shutdown" });
        assert.isUndefined(yield* registry.resolve(token));
      }).pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, pauseResolve: { armed, paused } }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 duplicate detach preserves replacement MCP credentials", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-replacement-mcp");
      const oldSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const replacementSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId: oldSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.detach({ providerSessionId: oldSessionId, threadId });
      yield* manager.open({
        threadId,
        providerSessionId: replacementSessionId,
        modelSelection,
        runtimePolicy,
      });

      const replacement = (yield* Ref.get(mcpConfigs)).at(-1);
      assert.isDefined(replacement);
      const replacementToken = replacement?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(replacementToken);
      assert.equal(
        (yield* mcpSessions.read(threadId))?.providerSessionId,
        replacement?.providerSessionId,
      );

      yield* manager.detach({ providerSessionId: oldSessionId, threadId });

      assert.equal(
        (yield* mcpSessions.read(threadId))?.providerSessionId,
        replacement?.providerSessionId,
      );
      assert.equal((yield* registry.resolve(replacementToken!))?.thread.threadId, threadId);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1_000,
          capabilities: ExclusiveCapabilities,
          mcpConfigs,
        }),
      ),
    );
  }),
);

// Exercise the real DTO decorator with the manager under test and committed
// destination state. Only the run fixture and unrelated transport ports are synthetic.
const readPreparedRunDto = Effect.fnUntraced(function* (
  threadId: ThreadId,
  runId: RunId,
  delegatedTaskId: NodeId,
  pastRunCount = 0,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const committed = yield* Effect.serviceOption(ServerSettings.MemoryProviderCommittedPolicy);
  if (Option.isNone(committed)) return yield* Effect.die("test requires committed memory policy");
  const projection = yield* store.getThreadProjection(threadId);
  const run: OrchestrationV2Run = {
    id: runId,
    delegatedTaskId,
    threadId,
    ordinal: 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("reattach-message"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: projection.thread.createdAt,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    memoryGrantCeiling: "read_write",
  };
  const runs = [
    ...Array.from({ length: pastRunCount }, (_, index) => ({
      ...run,
      id: RunId.make(`historical-run-${index}`),
      ordinal: index + 2,
    })),
    run,
  ];
  let threadReads = 0;
  const countThreadReads: Statement.Transformer = (statement) => {
    const [query] = statement.compile();
    if (query.includes("SELECT payload_json FROM orchestration_v2_projection_threads")) {
      threadReads++;
    }
    return Effect.succeed(statement);
  };
  return yield* Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const records = yield* threads.getThreadRecords(threadId, ["runs"]);
    if (pastRunCount > 0) {
      assert.equal(threadReads, 1);
      for (const historical of records.runs.slice(0, -1)) {
        assert.notProperty(historical, "currentMemoryAccess");
      }
    }
    return records.runs.at(-1)!;
  }).pipe(
    Effect.provide(
      ThreadManagement.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, manager),
            Layer.succeed(ServerSettings.ServerSettingsService, settings),
            Layer.succeed(ServerSettings.MemoryProviderCommittedPolicy, committed.value),
            Layer.mock(Receipts.CommandReceiptStoreV2)({}),
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () => Effect.succeed({ ...projection, runs }),
            }),
          ),
        ),
      ),
    ),
    Effect.provideService(Statement.CurrentTransformer, countThreadReads),
  );
});

it.effect(
  "ProviderSessionManagerV2 keeps a thread's MCP credential stable across detach and re-attach on a shared session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const settingsLayer = ServerSettings.layerTest();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-stable-mcp");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const oldRunId = RunId.make("reattach-old-run");
        const oldTaskId = NodeId.make("reattach-old-task");
        const runId = RunId.make("reattach-new-run");
        const taskId = NodeId.make("reattach-new-task");
        yield* manager.open({
          runId: oldRunId,
          delegatedTaskId: oldTaskId,
          memoryGrantCeiling: "read_write",
          dispatchScopes: ["memory:read"],
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const original = (yield* Ref.get(mcpConfigs)).at(-1);
        assert.isDefined(original);
        const originalToken = original?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(originalToken);

        // Workspace-change handoff on a shared multi-thread session (codex):
        // the thread detaches while the provider process keeps running, and the
        // process's MCP client keeps using the credential it was started with.
        yield* manager.detach({ providerSessionId, threadId, detail: "Workspace changed." });
        assert.equal(
          (yield* registry.resolve(originalToken!))?.thread.threadId,
          threadId,
          "detach must not revoke the credential the live provider process still holds",
        );

        assert.isUndefined(yield* manager.memoryAccessInputs!(threadId, modelSelection.instanceId));
        assert.isUndefined(
          (yield* readPreparedRunDto(threadId, oldRunId, oldTaskId)).currentMemoryAccess,
        );

        // The continuation run re-attaches the same thread to the same session;
        // the credential must be reused, not rotated, so the provider process's
        // long-lived MCP client stays authorized.
        yield* manager.prepareMcpSession!({
          threadId,
          providerInstanceId: modelSelection.instanceId,
          runId,
          delegatedTaskId: taskId,
          memoryGrantCeiling: "read_write",
          dispatchScopes: ["memory:read"],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
          runId,
          delegatedTaskId: taskId,
          memoryGrantCeiling: "read_write",
        });
        const prepared = yield* manager.memoryAccessInputs!(threadId, modelSelection.instanceId);
        assert.equal(prepared?.runId, runId);
        assert.equal(prepared?.delegatedTaskId, taskId);
        assert.equal((yield* manager.currentMemoryPolicy!(threadId)).grant, "read");
        assert.deepEqual((yield* readPreparedRunDto(threadId, runId, taskId)).currentMemoryAccess, {
          access: "read",
          reason: "dispatch_scope",
        });
        assert.isUndefined(
          (yield* readPreparedRunDto(threadId, oldRunId, oldTaskId)).currentMemoryAccess,
        );

        assert.equal(
          (yield* mcpSessions.read(threadId))?.providerSessionId,
          original?.providerSessionId,
          "re-attach must reuse the existing credential, not rotate it",
        );
        assert.equal((yield* registry.resolve(originalToken!))?.thread.threadId, threadId);

        // A new admission with no execution IDs must not inherit the old IDs.
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
          memoryGrantCeiling: "read_write",
          dispatchScopes: ["memory:read"],
        });
        const ordinary = yield* manager.memoryAccessInputs!(threadId, modelSelection.instanceId);
        assert.isUndefined(ordinary?.runId);
        assert.isUndefined(ordinary?.delegatedTaskId);

        // Releasing the session (provider process gone) still revokes.
        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* registry.resolve(originalToken!));
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            serverSettingsLayer: settingsLayer,
          }).pipe(Layer.provideMerge(settingsLayer)),
        ),
      );
    }),
);

it.effect("current memory DTO withholds access until the committed on epoch is installed", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const initialized = yield* Deferred.make<void>();
    const blocked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const baseSettings = ServerSettings.layerTest({ enableAgentMemoryAccess: false });
    // Hold the real rotation subscriber before prepare starts, after the settings
    // service has committed/published on. The old installed credential stays live.
    const settingsLayer = Layer.effect(
      ServerSettings.MemoryProviderCommittedPolicy,
      Effect.gen(function* () {
        const policy = Option.getOrThrow(
          yield* Effect.serviceOption(ServerSettings.MemoryProviderCommittedPolicy),
        );
        return {
          ...policy,
          subscribeRotations: policy.subscribeRotations.pipe(
            Effect.map((stream) =>
              stream.pipe(
                Stream.flatMap((event) =>
                  event.enableAgentMemoryAccess
                    ? Stream.fromEffect(
                        Deferred.succeed(blocked, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                          Effect.as(event),
                        ),
                      ).pipe(
                        Stream.concat(
                          Stream.fromEffect(Deferred.succeed(completed, undefined)).pipe(
                            Stream.drain,
                          ),
                        ),
                      )
                    : Stream.make(event).pipe(
                        Stream.concat(
                          Stream.fromEffect(Deferred.succeed(initialized, undefined)).pipe(
                            Stream.drain,
                          ),
                        ),
                      ),
                ),
              ),
            ),
          ),
        };
      }),
    ).pipe(Layer.provideMerge(baseSettings));
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const policy = Option.getOrThrow(
        yield* Effect.serviceOption(ServerSettings.MemoryProviderCommittedPolicy),
      );
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const configs = yield* McpProviderSessions.McpProviderSessions;
      const threadId = ThreadId.make("memory-on-before-rotation");
      const runId = RunId.make("on-run");
      const taskId = NodeId.make("on-task");
      const now = yield* DateTime.now;
      const providerSessionId = yield* ids.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* sink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
      });
      yield* Deferred.await(initialized);
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
        runId,
        delegatedTaskId: taskId,
        memoryGrantCeiling: "read_write",
      });
      const old = (yield* configs.read(threadId))!;
      const oldToken = old.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.equal((yield* registry.resolve(oldToken))?.memoryPolicy?.grant, "none");
      yield* settings.updateSettings({ enableAgentMemoryAccess: true });
      yield* Deferred.await(blocked);
      assert.isTrue((yield* policy.read).enableAgentMemoryAccess);
      assert.equal((yield* configs.read(threadId))?.providerSessionId, old.providerSessionId);
      assert.isUndefined(yield* registry.currentMemoryPolicy!(old.providerSessionId));
      // The drifted credential keeps working for everything but memory.
      const drifted = yield* registry.resolve(oldToken);
      assert.equal(drifted?.memoryPolicy?.grant, "none");
      assert.isFalse(drifted?.capabilities.has("memory"));
      assert.equal((yield* manager.currentMemoryPolicy!(threadId)).grant, "none");
      assert.isUndefined((yield* readPreparedRunDto(threadId, runId, taskId)).currentMemoryAccess);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(completed);
      const installed = (yield* configs.read(threadId))!;
      assert.equal(installed.providerSessionId, old.providerSessionId);
      assert.equal(installed.authorizationHeader, old.authorizationHeader);
      assert.notEqual(installed.credentialGeneration, old.credentialGeneration);
      const scope = yield* registry.resolve(
        installed.authorizationHeader.replace(/^Bearer\s+/, ""),
      );
      assert.equal(scope?.memoryPolicy?.grant, "read_write");
      assert.deepEqual(
        yield* registry.currentMemoryPolicy!(installed.providerSessionId),
        scope?.memoryPolicy,
      );
      assert.equal((yield* manager.currentMemoryPolicy!(threadId)).grant, "read_write");
      assert.equal(
        (yield* readPreparedRunDto(threadId, runId, taskId)).currentMemoryAccess?.access,
        "read_write",
      );
    }).pipe(
      Effect.provide(
        layerTest({ state, idleTimeoutMs: 60_000, serverSettingsLayer: settingsLayer }).pipe(
          Layer.provideMerge(settingsLayer),
        ),
      ),
    );
  }),
);

it.effect.each(["resolve", "unrelated issue"] as const)(
  "current memory DTO denies idle live attachments until a call renews them, after prune by %s",
  (pruneBy) =>
    Effect.gen(function* () {
      let timestamp = 1_000;
      const state = yield* Ref.make(emptyState);
      const initialized = yield* Deferred.make<void>();
      const settingsLayer = Layer.effect(
        ServerSettings.MemoryProviderCommittedPolicy,
        Effect.gen(function* () {
          const policy = Option.getOrThrow(
            yield* Effect.serviceOption(ServerSettings.MemoryProviderCommittedPolicy),
          );
          return {
            ...policy,
            subscribeRotations: policy.subscribeRotations.pipe(
              Effect.map((stream) =>
                stream.pipe(
                  Stream.flatMap((event) =>
                    Stream.make(event).pipe(
                      Stream.concat(
                        Stream.fromEffect(Deferred.succeed(initialized, undefined)).pipe(
                          Stream.drain,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          };
        }),
      ).pipe(Layer.provideMerge(ServerSettings.layerTest()));
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const configs = yield* McpProviderSessions.McpProviderSessions;
        const threadId = ThreadId.make(`memory-expired-${pruneBy}`);
        const runId = RunId.make("expired-run");
        const taskId = NodeId.make("expired-task");
        const now = yield* DateTime.now;
        const providerSessionId = yield* ids.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* sink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
        });
        // The initial policy snapshot must finish its rotation before the
        // controlled interval starts; prepare reuse legitimately touches liveness.
        yield* Deferred.await(initialized);
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
          runId,
          delegatedTaskId: taskId,
          memoryGrantCeiling: "read_write",
        });
        const config = (yield* configs.read(threadId))!;
        const token = config.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.equal((yield* manager.currentMemoryPolicy!(threadId)).grant, "read_write");
        assert.equal(
          (yield* readPreparedRunDto(threadId, runId, taskId, 32)).currentMemoryAccess?.access,
          "read_write",
        );
        // The exact boundary remains live. Snapshot reads must not extend it.
        timestamp += 100;
        assert.isDefined(yield* registry.currentMemoryPolicy!(config.providerSessionId));
        assert.isDefined((yield* readPreparedRunDto(threadId, runId, taskId)).currentMemoryAccess);
        timestamp += 1;
        assert.isUndefined(yield* registry.currentMemoryPolicy!(config.providerSessionId));
        assert.equal((yield* manager.currentMemoryPolicy!(threadId)).grant, "none");
        assert.isUndefined(
          (yield* readPreparedRunDto(threadId, runId, taskId)).currentMemoryAccess,
        );
        if (pruneBy === "unrelated issue") {
          yield* registry.issue({
            threadId: ThreadId.make("unrelated-live-credential"),
            providerInstanceId: modelSelection.instanceId,
          });
          // An unrelated issue probes attachment and keeps a credential its session still
          // holds; it stays idle, so snapshot reads still deny it.
          assert.equal(
            (yield* configs.read(threadId))?.providerSessionId,
            config.providerSessionId,
          );
        }
        assert.isUndefined(yield* registry.currentMemoryPolicy!(config.providerSessionId));
        assert.isUndefined(
          (yield* readPreparedRunDto(threadId, runId, taskId)).currentMemoryAccess,
        );
        assert.isUndefined(yield* manager.memoryAccessInputs!(threadId, modelSelection.instanceId));
        // A call from the session GOAT still holds renews its credential, so a
        // provider that cannot take a new token keeps working after a long idle.
        assert.equal((yield* registry.resolve(token))?.thread.threadId, threadId);
        assert.isDefined(yield* registry.currentMemoryPolicy!(config.providerSessionId));
        assert.equal((yield* configs.read(threadId))?.providerSessionId, config.providerSessionId);
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        // Once GOAT releases the session an idle credential stays expired.
        yield* manager.close(providerSessionId);
        timestamp += 200;
        assert.isUndefined(yield* registry.resolve(token));
        assert.isUndefined(yield* registry.currentMemoryPolicy!(config.providerSessionId));
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            serverSettingsLayer: settingsLayer,
            registryOptions: { now: () => timestamp, livenessWindowMs: 100 },
          }).pipe(Layer.provideMerge(settingsLayer)),
        ),
      );
    }),
);

it.effect("current memory DTO denies an archived destination before a deferred detach", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const settingsLayer = ServerSettings.layerTest();
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("memory-archive-before-detach");
      const runId = RunId.make("archive-run");
      const taskId = NodeId.make("archive-task");
      const now = yield* DateTime.now;
      const providerSessionId = yield* ids.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* sink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
        runId,
        delegatedTaskId: taskId,
        memoryGrantCeiling: "read_write",
      });
      assert.equal(
        (yield* readPreparedRunDto(threadId, runId, taskId)).currentMemoryAccess?.access,
        "read_write",
      );
      const before = yield* store.getThreadProjection(threadId);
      // Commit through the real event sink. Hold the follow-up detach behind a
      // Deferred, fixing the commit/effect boundary without timers or a worker race.
      yield* sink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            type: "thread.archived",
            threadId,
            occurredAt: now,
            payload: { ...before.thread, archivedAt: now },
          },
        ],
      });
      const releaseDetach = yield* Deferred.make<void>();
      const detach = yield* Deferred.await(releaseDetach).pipe(
        Effect.andThen(manager.detach({ threadId, providerSessionId })),
        Effect.forkChild,
      );
      assert.isNotNull((yield* store.getThreadProjection(threadId)).thread.archivedAt);
      assert.equal((yield* manager.currentMemoryPolicy!(threadId)).grant, "none");
      // The runtime stays attached, but execution policy now denies the
      // destination, so the positive-evidence getter must deny it too.
      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      assert.isUndefined(yield* manager.memoryAccessInputs!(threadId, modelSelection.instanceId));
      assert.isUndefined((yield* readPreparedRunDto(threadId, runId, taskId)).currentMemoryAccess);
      // Preparing against the archived destination issues none. Unarchiving alone
      // cannot turn that earlier denied prepare into positive evidence.
      yield* manager.prepareMcpSession!({
        threadId,
        providerInstanceId: modelSelection.instanceId,
        runId,
        delegatedTaskId: taskId,
        memoryGrantCeiling: "read_write",
      });
      yield* sink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            type: "thread.unarchived",
            threadId,
            occurredAt: now,
            payload: before.thread,
          },
        ],
      });
      assert.isUndefined(yield* manager.memoryAccessInputs!(threadId, modelSelection.instanceId));
      assert.isUndefined((yield* readPreparedRunDto(threadId, runId, taskId)).currentMemoryAccess);
      yield* Deferred.succeed(releaseDetach, undefined);
      yield* Fiber.join(detach);
    }).pipe(
      Effect.provide(
        layerTest({ state, idleTimeoutMs: 60_000, serverSettingsLayer: settingsLayer }).pipe(
          Layer.provideMerge(settingsLayer),
        ),
      ),
    );
  }),
);

it.effect(
  "scheduled task DTO stays unknown while read-only RuntimePolicyV2 actually prepares read",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const settingsLayer = ServerSettings.layerTest();
      const tasksLayer = ScheduledTasks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerTestDatabase,
            NodeServices.layer,
            settingsLayer,
            Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/projects",
              isScratchProject: () => Effect.succeed(false),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
          ),
        ),
      );
      const policyLayer = RuntimePolicy.layerWithOverride({ sandboxPolicy: "read-only" }).pipe(
        Layer.provide(RuntimePolicy.layer),
      );
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const resolver = yield* RuntimePolicy.RuntimePolicyV2;
        const settings = yield* ServerSettings.ServerSettingsService;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("scheduled-read-only-policy");
        yield* sink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
        });
        const thread = (yield* store.getThreadProjection(threadId)).thread;
        const { task } = yield* tasks.upsert(
          {
            title: "Policy fixture",
            prompt: "Work",
            enabled: true,
            schedule: { type: "interval", everyMs: 60_000 },
            projectId: thread.projectId,
            threadId,
            workspaceStrategy: { type: "root" },
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
          },
          { memoryGrantCeiling: "read_write" },
        );
        assert.equal(task.memoryGrantCeiling, "read_write");
        assert.isUndefined(task.currentMemoryAccess);
        assert.isUndefined((yield* tasks.list()).tasks[0]?.currentMemoryAccess);
        const policy = yield* resolver.resolve({ thread, modelSelection });
        const providerSessionId = yield* ids.allocate.providerSession({
          threadId,
          providerInstanceId: modelSelection.instanceId,
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy: policy,
          runId: RunId.make("scheduled-read-only-run"),
          memoryGrantCeiling: task.memoryGrantCeiling ?? "none",
        });
        const configs = yield* McpProviderSessions.McpProviderSessions;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const config = yield* configs.read(threadId);
        assert.deepEqual(config?.grantedScopes, ["memory:read", "orchestration:read"]);
        assert.isDefined(config);
        // Resolve the provider's credential as the MCP handshake does. A raw
        // policy read can race the post-open liveness touch's record fence.
        const issued = yield* registry.resolve(
          config!.authorizationHeader.replace(/^Bearer\s+/, ""),
        );
        assert.equal(issued?.memoryPolicy?.grant, "read");
        assert.equal((yield* manager.currentMemoryPolicy!(threadId)).grant, "read");
        assert.isTrue(
          (yield* manager.memoryAccessInputs!(threadId, modelSelection.instanceId))?.readOnly,
        );
        yield* settings.updateSettings({ enableAgentMemoryAccess: false });
        assert.deepEqual((yield* tasks.list()).tasks[0]?.currentMemoryAccess, {
          access: "none",
          reason: "environment_off",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerTest({ state, idleTimeoutMs: 60_000, serverSettingsLayer: settingsLayer }),
            settingsLayer,
            tasksLayer,
            policyLayer,
          ),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 protects a reused credential from a predecessor release during open",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const duringOpen = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-open-race");
        const s1 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const s2 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({ threadId, providerSessionId: s1, modelSelection, runtimePolicy });
        const original = (yield* Ref.get(mcpConfigs)).at(-1);
        const originalToken = original?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(originalToken);
        yield* manager.detach({ providerSessionId: s1, threadId });

        // While S2's provider process is spawning (after prepare reused the
        // credential, before the entry is visible), the predecessor session
        // releases. Eager adapters (ACP, OpenCode) bake the credential into
        // the process during openSession, so the release must not revoke it;
        // rotating afterwards cannot repair those adapters.
        yield* Ref.set(duringOpen, manager.close(s1).pipe(Effect.orDie));
        yield* manager.open({ threadId, providerSessionId: s2, modelSelection, runtimePolicy });

        const slot = yield* mcpSessions.read(threadId);
        assert.equal(
          slot?.providerSessionId,
          original?.providerSessionId,
          "the credential the adapter was configured with must remain current",
        );
        assert.equal(
          (yield* registry.resolve(originalToken!))?.thread.threadId,
          threadId,
          "the predecessor release must not revoke a credential reserved by an in-flight open",
        );
        yield* manager.close(s2);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            beforeOpen: (input) =>
              input.providerSessionId === undefined
                ? Effect.void
                : Ref.get(duringOpen).pipe(
                    Effect.flatten,
                    Effect.tap(() => Ref.set(duringOpen, Effect.void)),
                  ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 terminal detach revokes the thread's MCP credential", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-terminal-detach");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const issued = (yield* Ref.get(mcpConfigs)).at(-1);
      const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(yield* registry.resolve(token!));

      yield* manager.detach({
        providerSessionId,
        threadId,
        detail: "Thread deleted.",
        revokeMcpCredential: true,
      });
      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(yield* mcpSessions.read(threadId));
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1_000, mcpConfigs })));
  }),
);

const openSessionWithBackgroundCommand = (fixtureName: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const now = yield* DateTime.now;
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName,
      projectId: yield* idAllocator.allocate.project({ fixtureName }),
    });
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: modelSelection.instanceId,
      threadId,
    });
    const otherProviderSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: modelSelection.instanceId,
      threadId,
    });
    const pendingBackgroundTasks = [
      { taskId: "dev-server", kind: "command", description: "python3 -m http.server" },
    ] as const;
    const providerThreads = [
      {
        ...makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
        pendingBackgroundTasks,
      },
      {
        ...makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId: otherProviderSessionId,
          now,
          nativeThreadId: "native-thread-other-session",
        }),
        pendingBackgroundTasks,
      },
    ];
    const writeProviderThread = (payload: OrchestrationV2ProviderThread) =>
      Effect.gen(function* () {
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload,
            },
          ],
        });
      });
    yield* eventSink.write({
      events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
    });
    yield* Effect.forEach(providerThreads, writeProviderThread);
    yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
    const rosters = Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const projection = yield* projectionStore.getThreadProjection(threadId);
      return providerThreads.map((seeded) =>
        (
          projection.providerThreads.find((thread) => thread.id === seeded.id)
            ?.pendingBackgroundTasks ?? []
        ).map((task) => task.taskId),
      );
    });
    return { threadId, providerSessionId, providerThreads, writeProviderThread, rosters };
  });

it.effect(
  "ProviderSessionManagerV2 clears the background roster of a session a detach releases",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const { threadId, providerSessionId, rosters } = yield* openSessionWithBackgroundCommand(
          "provider-session-manager-detach-roster",
        );
        assert.deepStrictEqual(yield* rosters, [["dev-server"], ["dev-server"]]);

        yield* manager.detach({ providerSessionId, threadId, detail: "Thread settled." });

        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.deepStrictEqual(yield* rosters, [[], ["dev-server"]]);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, capabilities: ExclusiveCapabilities }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 keeps the roster of a runtime whose tasks can outlive it", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const { providerSessionId, rosters } = yield* openSessionWithBackgroundCommand(
        "provider-session-manager-outliving-roster",
      );

      yield* manager.close(providerSessionId);

      assert.deepStrictEqual(yield* rosters, [["dev-server"], ["dev-server"]]);
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({ state, idleTimeoutMs: 60_000, backgroundTasksEndWithProcess: false }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 keeps a provider update that lands while release clears", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const beforeUnchangedWrite = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const effect = Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const { providerSessionId, providerThreads, writeProviderThread, rosters } =
        yield* openSessionWithBackgroundCommand("provider-session-manager-raced-roster");
      const seeded = providerThreads[0]!;
      yield* Ref.set(
        beforeUnchangedWrite,
        writeProviderThread({
          ...seeded,
          pendingBackgroundTasks: [
            ...seeded.pendingBackgroundTasks,
            { taskId: "replacement-task", kind: "command" },
          ],
        }).pipe(Effect.orDie),
      );

      yield* manager.close(providerSessionId);

      assert.deepStrictEqual(yield* rosters, [["replacement-task"], ["dev-server"]]);
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, beforeUnchangedWrite })),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 does not idle-release a session that turns busy during the pending-work check",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const firstCheck = yield* Ref.make(true);
      const checkEntered = yield* Deferred.make<void>();
      const checkGate = yield* Deferred.make<void>();
      const busyMarked = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-busy-during-check",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-busy-during-check",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = idAllocator.derive.rootNode({ runId });
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn-busy-during-check",
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const subscription = yield* Effect.acquireRelease(
          runtime.subscribeEvents!,
          (sub) => sub.close,
        );
        const terminalProcessed = yield* subscription.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;

        yield* TestClock.adjust("1 second");
        yield* Deferred.await(checkEntered);

        const turnFiber = yield* runtime
          .startTurn({
            appThread,
            threadId,
            runId,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId,
            rootNodeId,
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
              text: "hello",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkDetach);
        // markBusy updates the live entry before waiting for the parked
        // probe to exit. Adapter startTurn cannot be reached until it exits.
        yield* Deferred.await(busyMarked);
        yield* Deferred.succeed(checkGate, undefined);
        yield* Fiber.join(turnFiber);

        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: providerThread.id,
          providerTurnId,
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(terminalProcessed);
        const afterSequence = yield* eventSink.latestSequence({ threadId });
        yield* TestClock.adjust("1 second");
        yield* eventSink.stream({ threadId, afterSequence }).pipe(
          Stream.filter(
            (entry) =>
              entry.event.type === "provider-session.updated" &&
              entry.event.payload.status === "stopped",
          ),
          Stream.runHead,
        );
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 1000,
            beforeIdleFiberInterrupt: Deferred.succeed(busyMarked, undefined).pipe(Effect.asVoid),
            // Uninterruptible so the markBusy-triggered interrupt cannot land
            // inside the check, mirroring an adapter that masks interruption
            // while inspecting its own state.
            hasPendingBackgroundWork: Effect.uninterruptible(
              Effect.gen(function* () {
                if (yield* Ref.getAndSet(firstCheck, false)) {
                  yield* Deferred.succeed(checkEntered, undefined);
                  yield* Deferred.await(checkGate);
                }
                return false;
              }),
            ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 releases sessions when provider event streams fail", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-stream-error",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-stream-error",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.events.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
      yield* Effect.yieldNow;

      const liveSession = yield* manager.get(providerSessionId);
      const runtimeState = yield* Ref.get(state);
      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.isTrue(Option.isNone(liveSession));
      assert.equal(runtimeState.closeCount, 1);
      assert.equal(projection.providerSessions.at(-1)?.status, "error");
    });

    yield* effect.pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1000,
          failEventStream: true,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 marks pending runtime requests non-live on release", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-request-expire",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-request-expire",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      yield* eventSink.write({ events: pendingRequest.events });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.release({
        providerSessionId,
        reason: "runtime_error",
        detail: "process exited",
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.at(-1);
      const requestNode = projection.nodes.find((node) => node.id === request?.nodeId);
      const requestTurnItem = projection.turnItems.find(
        (item) => item.type === "approval_request" && item.requestId === request?.id,
      );

      assert.equal(request?.status, "expired");
      assert.equal(request?.responseCapability.type, "not_resumable");
      assert.equal(requestNode?.status, "failed");
      assert.equal(requestTurnItem?.status, "failed");
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
  }),
);
it.effect("ProviderSessionManagerV2 retries release records that failed to persist", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const flaky: FlakyReleaseWrites = {
      failing: yield* Ref.make<"none" | "session" | "session-and-requests">("session"),
      failures: yield* Queue.unbounded<void>(),
    };
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-release-retry");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({ idAllocator, threadId, providerSessionId, now });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      yield* eventSink.write({ events: pendingRequest.events });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

      assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.close(providerSessionId))));
      yield* Queue.take(flaky.failures);
      const afterClose = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(afterClose.runtimeRequests.at(-1)?.responseCapability.type, "not_resumable");
      assert.equal(afterClose.providerSessions.at(-1)?.status, "ready");

      yield* TestClock.adjust("1 second");
      yield* Queue.take(flaky.failures);
      yield* Ref.set(flaky.failing, "none");
      const stopped = yield* eventSink
        .stream({
          threadId,
          afterSequence: yield* eventSink.latestSequence({ threadId }),
          eventType: "provider-session.updated",
        })
        .pipe(Stream.runHead, Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(stopped);

      const afterRetry = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(afterRetry.providerSessions.at(-1)?.status, "stopped");
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 release retries leave a replacement session alone", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const flaky: FlakyReleaseWrites = {
      failing: yield* Ref.make<"none" | "session" | "session-and-requests">("none"),
      failures: yield* Queue.unbounded<void>(),
    };
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread-provider-session-manager-release-replacement");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const writePendingRequest = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const request = yield* makePendingRuntimeRequestEvents({
          idAllocator,
          threadId,
          providerSessionId,
          providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
          now,
        });
        yield* eventSink.write({ events: request.events });
        return request.requestId;
      });
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId, now: yield* DateTime.now }),
        ],
      });
      const oldRequestId = yield* writePendingRequest;
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      yield* Ref.set(flaky.failing, "session-and-requests");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.close(providerSessionId))));
      yield* Queue.take(flaky.failures);
      yield* Queue.take(flaky.failures);
      yield* Ref.set(flaky.failing, "none");

      yield* TestClock.adjust("500 millis");
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const newRequestId = yield* writePendingRequest;
      const replacementStatus = (yield* projectionStore.getThreadProjection(
        threadId,
      )).providerSessions.at(-1)?.status;
      const settled = yield* eventSink
        .stream({
          threadId,
          afterSequence: yield* eventSink.latestSequence({ threadId }),
          eventType: "runtime-request.updated",
        })
        .pipe(Stream.runHead, Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(settled);

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = (id: typeof oldRequestId) =>
        projection.runtimeRequests.find((candidate) => candidate.id === id);
      assert.equal(request(oldRequestId)?.responseCapability.type, "not_resumable");
      assert.equal(request(newRequestId)?.responseCapability.type, "live");
      assert.equal(projection.providerSessions.at(-1)?.status, replacementStatus);
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 keeps each failed release's cleanup", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const flaky: FlakyReleaseWrites = {
      failing: yield* Ref.make<"none" | "session" | "session-and-requests">("none"),
      failures: yield* Queue.unbounded<void>(),
    };
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-release-each-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-release-each-b");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
        ],
      });
      const secondThreadRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId: secondThreadId,
        providerSessionId,
        providerThread: makeProviderThread({
          idAllocator,
          threadId: secondThreadId,
          providerSessionId,
          now,
        }),
        now,
      });
      yield* eventSink.write({ events: secondThreadRequest.events });
      const failRelease = (failedWrites: number) =>
        Effect.gen(function* () {
          yield* Ref.set(flaky.failing, "session-and-requests");
          assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.close(providerSessionId))));
          yield* Effect.repeat(Queue.take(flaky.failures), { times: failedWrites - 1 });
          yield* Ref.set(flaky.failing, "none");
        });

      yield* manager.open({
        threadId: firstThreadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({
        threadId: secondThreadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* failRelease(2);
      yield* TestClock.adjust("500 millis");
      yield* manager.open({
        threadId: firstThreadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* failRelease(1);

      const settled = yield* eventSink
        .stream({
          threadId: secondThreadId,
          afterSequence: yield* eventSink.latestSequence({ threadId: secondThreadId }),
          eventType: "runtime-request.updated",
        })
        .pipe(Stream.runHead, Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(settled);

      const projection = yield* projectionStore.getThreadProjection(secondThreadId);
      assert.equal(projection.runtimeRequests.at(-1)?.responseCapability.type, "not_resumable");
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 settles a request the event pump persists during release", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const flaky: FlakyReleaseWrites = {
      failing: yield* Ref.make<"none" | "session" | "session-and-requests">("none"),
      failures: yield* Queue.unbounded<void>(),
      pauseRequestWrites: {
        paused: yield* Deferred.make<void>(),
        resume: yield* Deferred.make<void>(),
      },
    };
    const pause = flaky.pauseRequestWrites!;
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-release-pump");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const createdAt = DateTime.add(now, { seconds: 1 });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread: makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now: createdAt,
        }),
        now: createdAt,
      });
      const adapterEvents = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterEvents);
      yield* Queue.offerAll(adapterEvents!, pendingRequest.providerEvents);
      yield* Deferred.await(pause.paused);
      const closed = yield* manager
        .close(providerSessionId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(pause.resume, undefined);
      yield* Fiber.join(closed);

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.find(
        (candidate) => candidate.id === pendingRequest.requestId,
      );
      assert.equal(request?.responseCapability.type, "not_resumable");
    });

    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
    );
  }),
);

it.effect("ProviderSessionManagerV2 persists session-scoped runtime requests without a run", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-session-request",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-session-request",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      const afterSequence = yield* eventSink.latestSequence({ threadId });
      const persistedFiber = yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "runtime-request.updated" ||
            stored.event.type === "node.updated" ||
            stored.event.type === "turn-item.updated",
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const adapterEvents = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterEvents);
      yield* Queue.offerAll(adapterEvents!, pendingRequest.providerEvents);
      const persisted = Array.from(yield* Fiber.join(persistedFiber));

      assert.sameMembers(
        persisted.map((stored) => stored.event.type),
        ["runtime-request.updated", "node.updated", "turn-item.updated"],
      );
      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.find(
        (candidate) => candidate.id === pendingRequest.requestId,
      );
      const node = projection.nodes.find((candidate) => candidate.id === pendingRequest.nodeId);
      const turnItem = projection.turnItems.find(
        (candidate) =>
          candidate.type === "approval_request" && candidate.requestId === pendingRequest.requestId,
      );
      assert.equal(request?.status, "pending");
      assert.equal(request?.providerTurnId, null);
      assert.equal(node?.runId, null);
      assert.equal(node?.status, "waiting");
      assert.equal(turnItem?.runId, null);
      assert.equal(turnItem?.status, "waiting");
    });

    yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 opens one shared runtime, broadcasts events, and detaches threads independently",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-shared-runtime",
        });
        const firstThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-shared-runtime-a",
          projectId,
        });
        const secondThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-shared-runtime-b",
          projectId,
        });
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });

        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
          ],
        });
        const firstProviderThread = makeProviderThread({
          idAllocator,
          threadId: firstThreadId,
          providerSessionId,
          now,
        });
        const secondProviderThread = makeProviderThread({
          idAllocator,
          threadId: secondThreadId,
          providerSessionId,
          now,
        });
        const firstRunId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-thread.updated",
              threadId: firstThreadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: firstProviderThread,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-turn.updated",
              threadId: firstThreadId,
              runId: firstRunId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: {
                id: idAllocator.derive.providerTurn({
                  driver: CODEX_DRIVER,
                  nativeTurnId: "native-turn-shared-runtime-a",
                }),
                providerThreadId: firstProviderThread.id,
                nodeId: idAllocator.derive.rootNode({ runId: firstRunId }),
                runAttemptId: null,
                nativeTurnRef: null,
                ordinal: 1,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            },
          ],
        });
        const firstRuntime = yield* manager.open({
          threadId: firstThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const secondRuntime = yield* manager.open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        assert.strictEqual(firstRuntime, secondRuntime);
        assert.equal((yield* Ref.get(state)).openCount, 1);
        const resumeSecondThread = secondRuntime.resumeThread({
          providerThread: secondProviderThread,
          threadId: secondThreadId,
          modelSelection,
          runtimePolicy,
        });
        yield* resumeSecondThread;
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 1);
        yield* secondRuntime.resumeThread({
          providerThread: secondProviderThread,
          threadId: secondThreadId,
          modelSelection: { ...modelSelection, model: "gpt-5.4-mini" },
          runtimePolicy,
        });
        assert.equal((yield* Ref.get(state)).resumeCount, 2);
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 3);
        const subscribe = firstRuntime.subscribeEvents;
        assert.isDefined(subscribe);
        if (subscribe === undefined) return;
        const firstSubscription = yield* subscribe;
        const secondSubscription = yield* subscribe;
        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: firstRuntime.providerSession,
        });
        const received = yield* Effect.all([
          firstSubscription.events.pipe(Stream.runHead),
          secondSubscription.events.pipe(Stream.runHead),
        ]);
        assert.isTrue(received.every(Option.isSome));
        assert.isTrue(
          received.every(
            (event) => Option.isSome(event) && event.value.type === "provider_session.updated",
          ),
        );

        yield* manager.detach({ providerSessionId, threadId: secondThreadId });
        yield* manager.open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 4);

        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);

        yield* manager.detach({ providerSessionId, threadId: firstThreadId });
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.equal((yield* Ref.get(state)).interruptCount, 1);
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["native-thread"]);

        yield* manager.detach({ providerSessionId, threadId: secondThreadId });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 re-attaching a thread waits for its in-flight unload, then reloads it",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const unloadStarted = yield* Deferred.make<void>();
      const releaseUnload = yield* Deferred.make<void>();
      let resumesBeforeUnload: number | undefined;
      const beforeUnload = Effect.gen(function* () {
        yield* Deferred.succeed(unloadStarted, undefined);
        yield* Deferred.await(releaseUnload);
        resumesBeforeUnload = (yield* Ref.get(state)).resumeCount;
      });
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-unload-race",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-unload-race-a",
          projectId,
        });
        const otherThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-unload-race-b",
          projectId,
        });
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: otherThreadId, now }),
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: providerThread,
            },
          ],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: otherThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const resume = runtime.resumeThread({
          providerThread,
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* resume;

        const detach = yield* manager
          .detach({ providerSessionId, threadId })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(unloadStarted);
        const reattach = yield* resume.pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseUnload, undefined);
        yield* Fiber.join(detach);
        yield* Fiber.join(reattach);

        assert.equal(resumesBeforeUnload, 1);
        assert.equal((yield* Ref.get(state)).resumeCount, 2);
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["native-thread"]);
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      });

      yield* effect.pipe(
        Effect.provide(layerTest({ state, idleTimeoutMs: 1000, beforeUnload })),
        Effect.scoped,
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 rejects a second thread when the provider runtime is exclusive",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-exclusive-runtime",
        });
        const firstThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-exclusive-runtime-a",
          projectId,
        });
        const secondThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-exclusive-runtime-b",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: firstThreadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
          ],
        });

        yield* manager.open({
          threadId: firstThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const error = yield* manager
          .open({
            threadId: secondThreadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderSessionOpenError");
        assert.equal((yield* Ref.get(state)).openCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 1000, capabilities: ExclusiveCapabilities }),
        ),
      );
    }),
);

it.effect.each(["missing", "file"] as const)(
  "rejects a %s workspace before opening a provider session",
  (workspaceState) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = `${root}/workspace`;
      if (workspaceState === "file") yield* fileSystem.writeFileString(cwd, "not a directory");
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadId = ThreadId.make(`thread-${workspaceState}-workspace`);
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        const error = yield* manager
          .open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy: { ...runtimePolicy, cwd },
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, ProviderWorkspaceMissingError);
        assert.include(error.message, cwd);
        assert.include(error.message, "Restore the folder at this path before retrying.");
        assert.equal((yield* Ref.get(state)).openCount, 0);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.deepEqual(
          (yield* projectionStore.getThreadProjection(threadId)).providerSessions,
          [],
        );
      }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects a deleted workspace before reusing a live session without changing its state",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = `${root}/workspace`;
      yield* fileSystem.makeDirectory(cwd);
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadId = ThreadId.make("thread-deleted-live-workspace");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        const input = {
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy: { ...runtimePolicy, cwd },
        };
        const runtime = yield* manager.open(input);
        const before = yield* projectionStore.getThreadProjection(threadId);
        yield* fileSystem.remove(cwd, { recursive: true });
        const error = yield* manager.open(input).pipe(Effect.flip);
        assert.instanceOf(error, ProviderWorkspaceMissingError);
        assert.equal((yield* Ref.get(state)).openCount, 1);
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.strictEqual(Option.getOrThrow(yield* manager.get(providerSessionId)), runtime);
        assert.deepEqual(
          (yield* projectionStore.getThreadProjection(threadId)).providerSessions,
          before.providerSessions,
        );
      }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderSessionManagerV2 applies project device access independently of browser access",
  () =>
    Effect.gen(function* () {
      const enabled = yield* runBrowserAccessScenario({
        enableAgentBrowserAccess: false,
        projectOverride: false,
        deviceOverride: true,
      });
      assert.isTrue(enabled?.capabilities?.has("device"));
      assert.isFalse(enabled?.browserToolsAvailable);
      const denied = yield* runBrowserAccessScenario({
        enableAgentBrowserAccess: false,
        projectOverride: false,
        deviceOverride: true,
        projectExists: false,
      });
      assert.isFalse(denied?.capabilities?.has("device"));
    }),
);

it.effect.each([false, true])(
  "cloud attach remains busy until terminal or shutdown=%s",
  (shutdown) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const attached = yield* Deferred.make<void>();
      const capabilities = {
        ...CodexCapabilities,
        sessions: {
          ...CodexCapabilities.sessions,
          executionLocation: "cloud" as const,
        },
      };
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`thread:cloud-attach-${shutdown}`);
        const providerSessionId = yield* ids.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* sink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const runId = ids.derive.run({ threadId, ordinal: 1 });
        const providerThread = makeProviderThread({
          idAllocator: ids,
          threadId,
          providerSessionId,
          now,
        });
        const cloudTask = {
          taskId: "accepted-cloud-session",
          status: "running" as const,
          tracking: "live" as const,
          source: { repository: "https://github.com/acme/repo", branch: "dev" },
          localChangesExcluded: false,
          updatedAt: DateTime.formatIso(now),
        };
        yield* runtime.resumeTurn!({
          appThread: (yield* store.getThreadProjection(threadId)).thread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: ids.derive.runAttempt({ runId, attemptOrdinal: 1 }),
          rootNodeId: ids.derive.rootNode({ runId }),
          providerThread: { ...providerThread, cloudTask },
          cloudTask,
          modelSelection,
          runtimePolicy,
        });
        yield* Deferred.await(attached);
        yield* TestClock.adjust("2 seconds");
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        if (shutdown) {
          yield* manager.shutdown;
        } else {
          const subscription = yield* runtime.subscribeEvents!;
          const terminal = yield* subscription.events.pipe(
            Stream.filter((event) => event.type === "turn.terminal"),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild,
          );
          const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId))!;
          yield* Queue.offer(queue, {
            type: "turn.terminal",
            driver: CODEX_DRIVER,
            providerThreadId: providerThread.id,
            providerTurnId: ids.derive.providerTurn({
              driver: CODEX_DRIVER,
              nativeTurnId: "cloud-attach-turn",
            }),
            runOrdinal: 1,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(terminal);
          yield* subscription.close;
          yield* TestClock.adjust("2 seconds");
          yield* Effect.yieldNow;
          assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        }
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        assert.equal((yield* Ref.get(state)).interruptCount, 0);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            capabilities,
            idleTimeoutMs: 1000,
            resumeTurn: Deferred.succeed(attached, undefined).pipe(Effect.asVoid),
          }),
        ),
      );
    }),
);

it.effect(
  "managed settings produce grants, task ceilings bound reuse, live runs and epoch rotations fence toolkit calls",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const settingsLayer = ServerSettings.layerTest();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const configs = yield* McpProviderSessions.McpProviderSessions;
        const settings = yield* ServerSettings.ServerSettingsService;
        const projection = yield* ProjectionStore.ProjectionStoreV2;
        const admission = yield* AdapterInfrastructure.ProviderMemoryAdmission;
        const adapterChanges = yield* Queue.unbounded<{
          threadId: ThreadId;
          providerInstanceId: ProviderInstanceId;
        }>();
        yield* admission.rotations.pipe(
          Stream.runForEach((event) => Queue.offer(adapterChanges, event)),
          Effect.forkScoped({ startImmediately: true }),
        );
        const changes = yield* Queue.unbounded<ProviderSessionManager.McpCredentialRotation>();
        yield* manager.mcpCredentialRotations!.pipe(
          Stream.runForEach((change) => Queue.offer(changes, change)),
          Effect.forkScoped({ startImmediately: true }),
        );
        const threadId = ThreadId.make("thread-memory-policy");
        const now = yield* DateTime.now;
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
          memoryGrantCeiling: null,
        });
        assert.equal((yield* admission.currentPolicy(threadId)).grant, "read_write");
        yield* Queue.take(changes);
        const initialAdapterRotation = yield* Queue.take(adapterChanges);
        assert.equal(initialAdapterRotation.threadId, threadId);
        assert.equal(initialAdapterRotation.providerInstanceId, modelSelection.instanceId);
        assert.deepEqual(
          yield* admission.currentPolicy(threadId),
          yield* manager.currentMemoryPolicy!(threadId),
        );
        assert.equal((yield* admission.currentPolicy(threadId)).grant, "read_write");
        const readScope = () =>
          Effect.gen(function* () {
            const config = yield* configs.read(threadId);
            assert.isDefined(config);
            const scope = yield* registry.resolve(
              config!.authorizationHeader.replace(/^Bearer\s+/, ""),
            );
            assert.isDefined(scope);
            return scope!;
          });
        const initial = yield* readScope();
        assert.deepEqual(initial.grantedScopes, [
          "memory:read",
          "memory:write",
          "orchestration:read",
        ]);
        assert.equal(
          (yield* initial.reauthorize!(["memory:read"]).pipe(Effect.flip))._tag,
          "EnvironmentAuthorizationError",
        );
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        yield* runtime.startTurn({
          appThread: (yield* projection.getThreadProjection(threadId)).thread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId }),
          providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "synthetic memory turn",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        const savedMemory = yield* MemoryToolkitFixture.call(
          "memory_upsert",
          MemoryToolkitFixture.upsert(),
          yield* readScope(),
        );
        assert.notEqual(savedMemory.result.isError, true, JSON.stringify(savedMemory.body));
        assert.notEqual(
          (yield* MemoryToolkitFixture.call(
            "memory_list",
            { memorySpaceId: MemoryToolkitFixture.space, includeQuarantined: false },
            yield* readScope(),
          )).result.isError,
          true,
        );
        for (const [ceiling, grant] of [
          ["none", "none"],
          ["read", "read"],
          ["read_write", "read_write"],
          [undefined, "none"],
          [null, "read_write"],
        ] as const) {
          const oldConfig = yield* configs.read(threadId);
          yield* manager.prepareMcpSession!({
            threadId,
            providerInstanceId: modelSelection.instanceId,
            ...(ceiling === undefined ? {} : { memoryGrantCeiling: ceiling }),
          });
          const admitted = yield* readScope();
          assert.equal(admitted.memoryPolicy?.grant, grant);
          assert.equal(admitted.grantedScopes?.includes("orchestration:read"), true);
          if (grant !== "read_write")
            assert.equal(
              (yield* admitted.reauthorize!(["memory:write"]).pipe(Effect.flip))._tag,
              "EnvironmentAuthorizationError",
            );
          if ((yield* configs.read(threadId))?.providerSessionId !== oldConfig?.providerSessionId)
            assert.isUndefined(
              yield* registry.resolve(oldConfig!.authorizationHeader.replace(/^Bearer\s+/, "")),
            );
        }
        yield* manager.prepareMcpSession!({
          threadId,
          providerInstanceId: modelSelection.instanceId,
          memoryGrantCeiling: null,
          readOnly: true,
        });
        assert.equal((yield* readScope()).memoryPolicy?.grant, "read");
        assert.equal(
          (yield* MemoryToolkitFixture.call(
            "memory_upsert",
            MemoryToolkitFixture.upsert(40),
            yield* readScope(),
          )).result.isError,
          true,
        );
        yield* manager.prepareMcpSession!({
          threadId,
          providerInstanceId: modelSelection.instanceId,
          memoryGrantCeiling: null,
          readOnly: false,
        });
        yield* Queue.clear(changes);
        yield* Queue.clear(adapterChanges);
        const old = yield* configs.read(threadId);
        const offReady = yield* Deferred.make<ProviderSessionManager.McpCredentialRotation>();
        yield* manager.mcpCredentialRotations!.pipe(
          Stream.filter((event) => event.memoryPolicy.grant === "none"),
          Stream.take(1),
          Stream.runForEach((event) => Deferred.succeed(offReady, event)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* settings.updateSettings({ enableAgentMemoryAccess: false });
        assert.equal(
          (yield* registry.resolve(old!.authorizationHeader.replace(/^Bearer\s+/, "")))
            ?.memoryPolicy?.grant,
          "none",
        );
        const off = yield* Deferred.await(offReady);
        assert.deepEqual(off.grantedScopes, ["orchestration:read"]);
        const offAdapterRotation = yield* Queue.take(adapterChanges);
        assert.equal(offAdapterRotation.threadId, off.threadId);
        assert.equal(offAdapterRotation.providerInstanceId, off.providerInstanceId);
        assert.equal((yield* admission.currentPolicy(threadId)).grant, "none");
        assert.deepEqual((yield* admission.fence(yield* configs.read(threadId)))?.grantedScopes, [
          "orchestration:read",
        ]);
        assert.equal((yield* readScope()).memoryPolicy?.grant, "none");
        const offConfig = yield* configs.read(threadId);
        const onReady = yield* Deferred.make<ProviderSessionManager.McpCredentialRotation>();
        yield* manager.mcpCredentialRotations!.pipe(
          Stream.filter((event) => event.memoryPolicy.grant === "read_write"),
          Stream.take(1),
          Stream.runForEach((event) => Deferred.succeed(onReady, event)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* settings.updateSettings({ enableAgentMemoryAccess: true });
        const on = yield* Deferred.await(onReady);
        // Re-enabling replaces authority under the token the provider already holds.
        assert.equal(
          (yield* configs.read(threadId))?.authorizationHeader,
          offConfig!.authorizationHeader,
        );
        assert.deepEqual(on.grantedScopes, ["memory:read", "memory:write", "orchestration:read"]);
        const admitted = yield* readScope();
        assert.isDefined(yield* registry.currentMemoryPolicy!(admitted.thread.providerSessionId));
        yield* admitted.reauthorize!(["memory:read"]);
        const attachedConfig = yield* configs.read(threadId);
        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* admission.fence(attachedConfig));
        assert.equal((yield* admission.currentPolicy(threadId)).grant, "none");
        assert.equal(
          (yield* admitted.reauthorize!(["memory:read"]).pipe(Effect.flip))._tag,
          "EnvironmentAuthorizationError",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerTest({ state, idleTimeoutMs: 1000, serverSettingsLayer: settingsLayer }),
            settingsLayer,
            MemoryToolkitFixture.layerForThreadEnvironment(
              EnvironmentId.make("environment-provider-session-manager"),
              layerTestDatabase,
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect.each(["new", "existing"] as const)(
  "prepare admission survives %s open, replacement restores grants, provider mismatch denies",
  (branch) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const settingsLayer = ServerSettings.layerTest();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const configs = yield* McpProviderSessions.McpProviderSessions;
        const projection = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("thread-memory-policy");
        const now = yield* DateTime.now;
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });

        if (branch === "existing")
          yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
        yield* manager.prepareMcpSession!({
          threadId,
          providerInstanceId: modelSelection.instanceId,
          memoryGrantCeiling: "read_write",
          dispatchScopes: ["memory:read"],
          readOnly: true,
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
          memoryGrantCeiling: "read_write",
        });
        const readScope = () =>
          Effect.gen(function* () {
            const config = yield* configs.read(threadId);
            const scope = yield* registry.resolve(
              config!.authorizationHeader.replace(/^Bearer\s+/, ""),
            );
            assert.isDefined(scope);
            return scope!;
          });
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        yield* runtime.startTurn({
          appThread: (yield* projection.getThreadProjection(threadId)).thread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId }),
          providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "synthetic memory turn",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });

        const restricted = yield* readScope();
        assert.equal(restricted.readOnly, true);
        assert.equal(restricted.memoryPolicy?.grant, "read");
        assert.equal(
          (yield* MemoryToolkitFixture.call(
            "memory_upsert",
            MemoryToolkitFixture.upsert(),
            restricted,
          )).result.isError,
          true,
        );
        for (const restriction of [
          { dispatchScopes: ["memory:read"] as const, readOnly: false },
          { dispatchScopes: ["memory:read", "memory:write"] as const, readOnly: true },
        ]) {
          yield* manager.prepareMcpSession!({
            threadId,
            providerInstanceId: modelSelection.instanceId,
            memoryGrantCeiling: "read_write",
            ...restriction,
          });
          yield* manager.open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
            memoryGrantCeiling: "read_write",
          });
          assert.equal((yield* readScope()).memoryPolicy?.grant, "read");
          assert.equal(
            (yield* MemoryToolkitFixture.call(
              "memory_upsert",
              MemoryToolkitFixture.upsert(),
              yield* readScope(),
            )).result.isError,
            true,
          );
        }
        yield* manager.prepareMcpSession!({
          threadId,
          providerInstanceId: modelSelection.instanceId,
          memoryGrantCeiling: null,
        });
        yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
        assert.equal((yield* readScope()).memoryPolicy?.grant, "read_write");
        const savedMemory = yield* MemoryToolkitFixture.call(
          "memory_upsert",
          MemoryToolkitFixture.upsert(),
          yield* readScope(),
        );
        assert.notEqual(savedMemory.result.isError, true, JSON.stringify(savedMemory.body));
        // A subsequent open without a fresh prepare cannot reuse the old admission.
        yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
        assert.equal((yield* readScope()).memoryPolicy?.grant, "none");
        yield* manager.prepareMcpSession!({
          threadId,
          providerInstanceId: ProviderInstanceId.make("different-provider"),
          memoryGrantCeiling: null,
        });
        yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
        assert.equal((yield* readScope()).memoryPolicy?.grant, "none");
        yield* manager.close(providerSessionId);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerTest({ state, idleTimeoutMs: 1000, serverSettingsLayer: settingsLayer }),
            settingsLayer,
            MemoryToolkitFixture.layerForThreadEnvironment(
              EnvironmentId.make("environment-provider-session-manager"),
              layerTestDatabase,
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect.each([
  { branch: "new", ceiling: undefined },
  { branch: "new", ceiling: "none" },
  { branch: "existing", ceiling: undefined },
  { branch: "existing", ceiling: "none" },
] as const)(
  "failed $branch open consumes admission before retry with ceiling=$ceiling",
  ({ branch, ceiling }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const state = yield* Ref.make(emptyState);
      const settingsLayer = ServerSettings.layerTest();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const configs = yield* McpProviderSessions.McpProviderSessions;
        const projection = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("thread-memory-policy");
        const now = yield* DateTime.now;
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const input = { threadId, providerSessionId, modelSelection, runtimePolicy };
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        if (branch === "existing") yield* manager.open(input);
        yield* manager.prepareMcpSession!({
          threadId,
          providerInstanceId: modelSelection.instanceId,
          memoryGrantCeiling: null,
        });
        const error = yield* manager
          .open({
            ...input,
            runtimePolicy: { ...runtimePolicy, cwd: `${root}/missing` },
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, ProviderWorkspaceMissingError);
        const runtime = yield* manager.open({
          ...input,
          ...(ceiling === undefined ? {} : { memoryGrantCeiling: ceiling }),
        });
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        yield* runtime.startTurn({
          appThread: (yield* projection.getThreadProjection(threadId)).thread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId }),
          providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "synthetic memory turn",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        const config = yield* configs.read(threadId);
        const scope = yield* registry.resolve(
          config!.authorizationHeader.replace(/^Bearer\s+/, ""),
        );
        assert.isDefined(scope);
        assert.equal(scope!.memoryPolicy?.grant, "none");
        for (const [tool, payload] of [
          ["memory_list", { memorySpaceId: MemoryToolkitFixture.space, includeQuarantined: false }],
          ["memory_upsert", MemoryToolkitFixture.upsert()],
        ] as const) {
          const result = yield* MemoryToolkitFixture.call(tool, payload, scope!);
          assert.equal(result.result.isError, true);
          assert.deepInclude(result.body, { code: "unavailable" });
        }
        yield* manager.close(providerSessionId);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerTest({ state, idleTimeoutMs: 60_000, serverSettingsLayer: settingsLayer }),
            settingsLayer,
            MemoryToolkitFixture.layerForThreadEnvironment(
              EnvironmentId.make("environment-provider-session-manager"),
              layerTestDatabase,
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each([
  { branch: "new", outcome: "failure" },
  { branch: "new", outcome: "interrupt" },
  { branch: "existing", outcome: "failure" },
  { branch: "existing", outcome: "interrupt" },
] as const)(
  "$branch open preflight $outcome preserves a later explicit admission",
  ({ branch, outcome }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = `${root}/missing`;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const state = yield* Ref.make(emptyState);
      const settingsLayer = ServerSettings.layerTest();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const configs = yield* McpProviderSessions.McpProviderSessions;
        const threadId = ThreadId.make("thread-memory-policy");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const input = { threadId, providerSessionId, modelSelection, runtimePolicy };
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        if (branch === "existing") yield* manager.open(input);
        yield* manager.prepareMcpSession!({
          threadId,
          providerInstanceId: modelSelection.instanceId,
          memoryGrantCeiling: "none",
        });
        const opening = yield* manager
          .open({
            ...input,
            runtimePolicy: { ...runtimePolicy, cwd },
          })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* manager.prepareMcpSession!({
          threadId,
          providerInstanceId: modelSelection.instanceId,
          memoryGrantCeiling: null,
        });
        if (outcome === "interrupt") {
          yield* Fiber.interrupt(opening);
        } else {
          yield* Deferred.succeed(release, undefined);
          const exit = yield* Fiber.join(opening);
          assert.isTrue(Exit.isFailure(exit));
        }
        yield* manager.open(input);
        const config = yield* configs.read(threadId);
        const scope = yield* registry.resolve(
          config!.authorizationHeader.replace(/^Bearer\s+/, ""),
        );
        assert.equal(scope?.memoryPolicy?.grant, "read_write");
        // The new admission is also single-use.
        yield* manager.open(input);
        const next = yield* configs.read(threadId);
        const nextScope = yield* registry.resolve(
          next!.authorizationHeader.replace(/^Bearer\s+/, ""),
        );
        assert.equal(nextScope?.memoryPolicy?.grant, "none");
        yield* manager.close(providerSessionId);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            serverSettingsLayer: settingsLayer,
            fileSystem: FileSystem.FileSystem.of({
              ...fileSystem,
              stat: (path) =>
                path === cwd
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(fileSystem.stat(path)),
                    )
                  : fileSystem.stat(path),
            }),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(["failure", "interrupt"] as const)(
  "adapter open %s cleanup preserves a later explicit admission with the same credential",
  (outcome) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* Ref.make(true);
      const state = yield* Ref.make(emptyState);
      const settingsLayer = ServerSettings.layerTest();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const configs = yield* McpProviderSessions.McpProviderSessions;
        const threadId = ThreadId.make("thread-memory-policy");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const input = { threadId, providerSessionId, modelSelection, runtimePolicy };
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        // No prepare before the first open: its freshly issued credential is
        // cleared on adapter failure. A concurrent prepare can reuse that id.
        const opening = yield* manager.open(input).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(entered);
        const before = yield* configs.read(threadId);
        yield* manager.prepareMcpSession!({
          threadId,
          providerInstanceId: modelSelection.instanceId,
          memoryGrantCeiling: "none",
        });
        assert.equal((yield* configs.read(threadId))?.providerSessionId, before?.providerSessionId);
        if (outcome === "interrupt") {
          yield* Fiber.interrupt(opening);
        } else {
          yield* Deferred.succeed(release, undefined);
          assert.isTrue(Exit.isFailure(yield* Fiber.join(opening)));
        }
        // A surviving none admission must still narrow this explicit null open.
        // If cleanup deleted it, the retry would incorrectly grant read_write.
        yield* manager.open({ ...input, memoryGrantCeiling: null });
        const config = yield* configs.read(threadId);
        const scope = yield* registry.resolve(
          config!.authorizationHeader.replace(/^Bearer\s+/, ""),
        );
        assert.equal(scope?.memoryPolicy?.grant, "none");
        yield* manager.close(providerSessionId);
      }).pipe(
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            serverSettingsLayer: settingsLayer,
            beforeOpen: () =>
              Effect.gen(function* () {
                if (!(yield* Ref.getAndSet(first, false))) return;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return yield* Effect.die("synthetic adapter handshake failure");
              }),
          }),
        ),
      );
    }).pipe(Effect.scoped),
);

// Exercise recovery admission through the real turn-start service and manager.
// The provider fixture resumes a native thread; run delivery is an explicit milestone.
const turnStartMemoryCases = [
  { name: "ordinary", kind: "ordinary", ceiling: undefined, expected: "read_write" },
  { name: "channel reply", kind: "channel", ceiling: undefined, expected: "none" },
  {
    name: "usage-limit ordinary",
    kind: "ordinary",
    ceiling: undefined,
    expected: "read_write",
    continuation: true,
  },
  {
    name: "usage-limit delegated read",
    kind: "delegated",
    ceiling: "read",
    expected: "read",
    continuation: true,
  },
  ...(["scheduled", "delegated"] as const).flatMap((kind) =>
    (["none", "read", "read_write"] as const).map(
      (ceiling) =>
        ({
          name: `${kind} ${ceiling}`,
          kind,
          ceiling,
          expected: ceiling,
        }) as const,
    ),
  ),
  { name: "legacy task", kind: "delegated", ceiling: undefined, expected: "none" },
  {
    name: "read-only sandbox",
    kind: "ordinary",
    ceiling: undefined,
    expected: "read",
    readOnly: true,
  },
  {
    name: "pending admission",
    kind: "delegated",
    ceiling: "none",
    expected: "read",
    pending: true,
  },
  {
    name: "pending admission plus read-only sandbox",
    kind: "delegated",
    ceiling: "none",
    expected: "read",
    pending: true,
    readOnly: true,
  },
  {
    name: "missing message",
    kind: "ordinary",
    ceiling: undefined,
    expected: "none",
    missingMessage: true,
  },
] as const;

type TurnStartMemoryCase = (typeof turnStartMemoryCases)[number];

it.effect.each(turnStartMemoryCases)(
  "turn-start memory admission: $name",
  (testCase: TurnStartMemoryCase) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const settingsLayer = ServerSettings.layerTest({ enableAgentMemoryAccess: true });
      const delivered = yield* Deferred.make<void>();
      let selections = 0;
      const projectionReads = { getThread: 0, getThreadShell: 0 };
      const refreshReads: Array<{ getThread: number; getThreadShell: number; selections: number }> =
        [];
      const frame = MemoryContext.packMemoryContext({
        memorySpaceId: MemoryContracts.MemorySpaceId.make("00000000-0000-4000-8000-000000000099"),
        projectionWatermark: 1,
        items: [
          {
            memoryId: MemoryContracts.MemoryId.make("00000000-0000-4000-8000-000000000001"),
            revisionId: MemoryContracts.MemoryRevisionId.make(
              "00000000-0000-4000-8000-000000000002",
            ),
            scope: { kind: "user" },
            provenance: { environmentId: EnvironmentId.make("fixture") },
            assertionKind: "fact",
            text: "memory & fixture",
          },
        ],
      });
      const onTurnInput = (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        Effect.gen(function* () {
          assert.isDefined(turnInput.refreshMemoryContext);
          // Admission is complete at the provider send boundary. Count only refresh work,
          // including a second send with the same callback (native retry).
          for (let send = 0; send < 2; send++) {
            projectionReads.getThread = 0;
            projectionReads.getThreadShell = 0;
            const beforeSelections = selections;
            const snapshot = yield* turnInput.refreshMemoryContext!();
            if (testCase.expected === "none") {
              assert.isUndefined(snapshot);
            } else {
              assert.equal(
                MemoryContext.memoryContextText(snapshot),
                MemoryContext.memoryContextText(frame),
              );
            }
            refreshReads.push({ ...projectionReads, selections: selections - beforeSelections });
          }
          yield* Deferred.succeed(delivered, undefined);
        });
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const configs = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-turn-start-memory");
        const providerSessionId = yield* ids.allocate.providerSession({
          threadId,
          providerInstanceId: modelSelection.instanceId,
        });
        const runId = ids.derive.run({ threadId, ordinal: 1 });
        const rootNodeId = ids.derive.rootNode({ runId });
        const attemptId = ids.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const messageId = yield* ids.allocate.message({ threadId, ordinal: 1 });
        const scopeId = CheckpointScopeId.make("scope-turn-start-memory");
        const providerThread = makeProviderThread({
          idAllocator: ids,
          threadId,
          providerSessionId,
          now,
        });
        const run: OrchestrationV2ThreadProjection["runs"][number] = {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId: providerThread.id,
          userMessageId: messageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "starting",
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
          ...(testCase.ceiling === undefined ? {} : { memoryGrantCeiling: testCase.ceiling }),
          ...(testCase.kind === "delegated"
            ? { delegatedTaskId: NodeId.make("task-turn-start-memory") }
            : {}),
        };
        const message: OrchestrationV2ThreadProjection["messages"][number] = {
          id: messageId,
          threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: "Synthetic recovery prompt",
          attachments: [],
          streaming: false,
          createdBy: testCase.kind === "delegated" ? "agent" : "user",
          creationSource: testCase.kind === "ordinary" ? "web" : "server",
          createdAt: now,
          updatedAt: now,
          ...(testCase.kind === "scheduled"
            ? { scheduledTaskId: ScheduledTaskId.make("schedule-turn-start-memory") }
            : {}),
        };
        const node: OrchestrationV2ThreadProjection["nodes"][number] = {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: null,
          completedAt: null,
        };
        const attempt: OrchestrationV2ThreadProjection["attempts"][number] = {
          id: attemptId,
          runId,
          rootNodeId,
          attemptOrdinal: 1,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          reason: "initial",
          status: "pending",
          startedAt: null,
          completedAt: null,
        };
        const checkpoint: OrchestrationV2ThreadProjection["checkpointScopes"][number] = {
          id: scopeId,
          threadId,
          runId,
          nodeId: rootNodeId,
          parentScopeId: null,
          providerThreadId: providerThread.id,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: process.cwd(),
          createdAt: now,
        };
        const eventBase = { threadId, occurredAt: now };
        const issued = yield* Queue.unbounded<ProviderSessionManager.McpCredentialRotation>();
        yield* manager.mcpCredentialRotations!.pipe(
          Stream.runForEach((change) => Queue.offer(issued, change)),
          Effect.forkScoped({ startImmediately: true }),
        );
        const initialEvents: Array<OrchestrationV2DomainEvent> = [
          yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now }),
          {
            ...eventBase,
            id: yield* ids.allocate.event({ threadId }),
            type: "run.updated",
            payload: run,
          },
          {
            ...eventBase,
            id: yield* ids.allocate.event({ threadId }),
            type: "node.updated",
            payload: node,
          },
          {
            ...eventBase,
            id: yield* ids.allocate.event({ threadId }),
            type: "run-attempt.updated",
            payload: attempt,
          },
          {
            ...eventBase,
            id: yield* ids.allocate.event({ threadId }),
            type: "provider-thread.updated",
            payload: providerThread,
          },
          {
            ...eventBase,
            id: yield* ids.allocate.event({ threadId }),
            type: "checkpoint-scope.created",
            payload: checkpoint,
          },
        ];
        if (!("missingMessage" in testCase))
          initialEvents.push({
            ...eventBase,
            id: yield* ids.allocate.event({ threadId }),
            type: "message.updated",
            payload: message,
          });
        yield* sink.write({ events: initialEvents });
        let startRunId = runId;
        if ("continuation" in testCase || testCase.kind === "channel") {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const original = { ...run, status: "failed" as const, completedAt: now };
          const resetAt = DateTime.formatIso(now);
          const requestId = CommandId.make("memory-recovery-request");
          const projection = yield* projections.getThreadProjection(threadId);
          yield* sink.write({
            commandId: CommandId.make("command:runtime-reconcile:memory-source"),
            events: [
              {
                ...eventBase,
                id: yield* ids.allocate.event({ threadId }),
                type: "run.updated",
                payload: original,
              },
              {
                ...eventBase,
                id: yield* ids.allocate.event({ threadId }),
                type: "thread.metadata-updated",
                payload: {
                  ...projection.thread,
                  limitRecovery: { runId, resetAt, autoResume: true, snooze: false, requestId },
                },
              },
              {
                ...eventBase,
                id: yield* ids.allocate.event({ threadId }),
                type: "turn-item.updated",
                payload: {
                  id: TurnItemId.make("memory-source-failure"),
                  type: "error",
                  threadId,
                  runId,
                  nodeId: rootNodeId,
                  providerThreadId: providerThread.id,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "failed",
                  title: "Usage limit",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  failure: {
                    class: "usage_limit",
                    message: "Synthetic limit",
                    code: null,
                    retryable: null,
                    resetAt,
                  },
                },
              },
            ],
          });
          if (testCase.kind === "channel") {
            const taskId = ChannelTaskId.make("memory-channel-task");
            const dispatcherLayer = ChannelDispatcher.layer.pipe(
              Layer.provide(Layer.mock(UsageLimitSources.UsageLimitSources)({})),
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(ChannelLedger.ChannelLedger)({
                    getTask: () =>
                      Effect.succeed({
                        ownerId: "owner",
                        pendingAnswerMessageId: undefined,
                        completionHold: undefined,
                        task: {
                          taskId,
                          worker: { threadId },
                          target: { projectId: ProjectId.make("project-1") },
                          requester: {
                            displayName: "Requester",
                            runtimeModeCeiling: "full-access",
                          },
                        },
                      } as ChannelLedger.ChannelStoredTask),
                    completeForward: () => Effect.void,
                  }),
                  Layer.mock(ThreadManagement.ThreadManagementService)({
                    sendToThread: (input) =>
                      orchestrator
                        .dispatch({
                          type: "message.dispatch",
                          commandId: input.commandId!,
                          threadId,
                          messageId: input.messageId,
                          text: input.text,
                          attachments: input.attachments,
                          createdBy: input.createdBy,
                          creationSource: input.creationSource,
                          dispatchMode: { type: "queue_after_active" },
                        })
                        .pipe(Effect.as({ threadId } as never)),
                  }),
                  Layer.mock(ProjectStore.ProjectStoreV2)({}),
                  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
                  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
                  Layer.mock(ChannelRemoteWorkers.ChannelRemoteWorkers)({}),
                  Layer.mock(SlackChannelSettings.SlackChannelSettings)({}),
                  Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment),
                  settingsLayer,
                  ServerConfig.layerTest(process.cwd(), { prefix: "memory-channel-" }).pipe(
                    Layer.provide(NodeServices.layer),
                  ),
                  Path.layer,
                  FileSystem.layerNoop({}),
                ),
              ),
            );
            yield* Effect.flatMap(ChannelDispatcher.ChannelDispatcher, (dispatcher) =>
              dispatcher.forward(
                {
                  sequence: 1,
                  event: {
                    taskId,
                    eventId: ChannelTaskEventId.make("memory-channel-answer"),
                    type: "task.question.answered",
                    payload: { answer: "Continue", questionId: ChannelQuestionId.make("question") },
                    sequence: 1,
                    taskVersion: 1,
                    actor: "user",
                    occurredAt: DateTime.formatIso(now),
                  },
                },
                "owner",
              ),
            ).pipe(Effect.provide(dispatcherLayer));
          } else {
            // An invalid public continuation command must not create a run.
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("memory-invalid-recovery"),
              threadId,
              messageId: MessageId.make("memory-invalid-recovery"),
              text: "Continue",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "start_immediately" },
              usageLimitContinuationOfRunId: runId,
              usageLimitRecoveryRequestId: CommandId.make("wrong-request"),
            });
            assert.lengthOf((yield* projections.getThreadProjection(threadId)).runs, 1);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("memory-valid-recovery"),
              threadId,
              messageId: MessageId.make("memory-valid-recovery"),
              text: "Continue",
              attachments: [],
              createdBy: "user",
              creationSource: "server",
              dispatchMode: { type: "start_immediately" },
              usageLimitContinuationOfRunId: runId,
              usageLimitRecoveryRequestId: requestId,
            });
          }
          const continued = (yield* projections.getThreadProjection(threadId)).runs.at(-1)!;
          assert.notEqual(continued.id, runId);
          if (testCase.kind !== "channel")
            assert.equal(continued.usageLimitContinuationOfRunId, runId);
          startRunId = continued.id;
          // Supply the native resume fixture's execution records for the admitted run.
          yield* sink.write({
            events: [
              {
                ...eventBase,
                id: yield* ids.allocate.event({ threadId }),
                type: "run.updated",
                payload: {
                  ...continued,
                  providerThreadId: providerThread.id,
                  rootNodeId: continued.rootNodeId,
                  activeAttemptId: continued.activeAttemptId,
                  status: "starting",
                },
              },
              {
                ...eventBase,
                id: yield* ids.allocate.event({ threadId }),
                type: "node.updated",
                payload: {
                  ...node,
                  id: continued.rootNodeId!,
                  rootNodeId: continued.rootNodeId!,
                  runId: startRunId,
                },
              },
              {
                ...eventBase,
                id: yield* ids.allocate.event({ threadId }),
                type: "run-attempt.updated",
                payload: {
                  ...attempt,
                  id: continued.activeAttemptId!,
                  rootNodeId: continued.rootNodeId!,
                  runId: startRunId,
                },
              },
              {
                ...eventBase,
                id: yield* ids.allocate.event({ threadId }),
                type: "checkpoint-scope.created",
                payload: { ...checkpoint, nodeId: continued.rootNodeId!, runId: startRunId },
              },
            ],
          });
        }
        if ("pending" in testCase) {
          yield* manager.prepareMcpSession!({
            threadId,
            providerInstanceId: modelSelection.instanceId,
            memoryGrantCeiling: "read_write",
            ...("readOnly" in testCase ? {} : { dispatchScopes: ["memory:read"] as const }),
          });
        }
        const policy = {
          ...runtimePolicy,
          ...("readOnly" in testCase ? { sandboxPolicy: "read-only" as const } : {}),
        };
        // The replay harness also builds this layer; use the manager under test here.
        const startLayer = Layer.fresh(ProviderTurnStart.layer).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(EventSink.EventSinkV2, sink),
              Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
              Layer.succeed(IdAllocator.IdAllocatorV2, ids),
              Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, manager),
              ContextHandoffService.layer.pipe(
                Layer.provide(Layer.succeed(IdAllocator.IdAllocatorV2, ids)),
              ),
              FileSystem.layerNoop({}),
              Layer.mock(GitWorkflow.GitWorkflowService)({}),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(ProviderAuthService.ProviderAuthService)({
                tryHandlePromptCommand: () => Effect.succeed(false),
              }),
              Path.layer,
              ServerConfig.layerTest(process.cwd(), { prefix: "memory-start-" }).pipe(
                Layer.provide(NodeServices.layer),
              ),
              Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: () => Effect.succeed(policy) }),
              Layer.mock(MemorySnapshot.MemorySnapshot)({
                forThread: (_threadId, issued, current) =>
                  Effect.gen(function* () {
                    selections++;
                    assert.deepEqual(issued, yield* current);
                    return frame;
                  }),
              }),
              RunExecutionService.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    McpAppModelContext.layerEmpty,
                    RemoteReportInbox.layerEmpty,
                    settingsLayer,
                    Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
                      allocate: () => Effect.succeed(1),
                    }),
                    Layer.succeed(EventSink.EventSinkV2, sink),
                    Layer.succeed(IdAllocator.IdAllocatorV2, ids),
                    Layer.mock(CheckpointService.CheckpointServiceV2)({
                      captureBaseline: () => Effect.void,
                    }),
                    Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
                      ingestNormalized: () => Effect.succeed([]),
                    }),
                  ),
                ),
              ),
            ),
          ),
        );
        const start = Effect.flatMap(ProviderTurnStart.ProviderTurnStartServiceV2, (service) =>
          service.start({ threadId, runId: startRunId }),
        ).pipe(Effect.provide(startLayer));
        if ("missingMessage" in testCase) {
          assert.equal((yield* start.pipe(Effect.flip))._tag, "ProviderTurnStartError");
          assert.equal((yield* Ref.get(state)).openCount, 0);
          assert.isUndefined(yield* configs.read(threadId));
        } else {
          yield* start;
          assert.isTrue(
            yield* Deferred.isDone(delivered),
            "actual send must reach fixture before start returns",
          );
          yield* Deferred.await(delivered);
          // Check counters outside the provider: a regression must report the actual reads,
          // rather than being translated into a failed send by the manager.
          const expectedReads =
            testCase.expected === "none"
              ? { getThread: 0, getThreadShell: 0, selections: 0 }
              : { getThread: 2, getThreadShell: 2, selections: 1 };
          // Allowed refreshes check initial authority and the snapshot's live checkpoint.
          assert.deepEqual(refreshReads, [expectedReads, expectedReads]);
          assert.equal(selections, testCase.expected === "none" ? 0 : 2);
          const constraints = yield* manager.memoryAccessInputs!(
            threadId,
            modelSelection.instanceId,
          );
          // This getter supplies positive DTO evidence. A denied credential
          // cannot supply it, even when its raw admission input is retained.
          if (testCase.expected === "none") assert.isUndefined(constraints);
          else {
            assert.isDefined(constraints);
            assert.equal(constraints!.runId, startRunId);
            assert.equal(constraints!.readOnly, "readOnly" in testCase);
          }
          assert.isUndefined(
            yield* manager.memoryAccessInputs!(threadId, ProviderInstanceId.make("other-provider")),
          );
          const config = yield* configs.read(threadId);
          assert.isDefined(config);
          const expectedScopes =
            testCase.expected === "none"
              ? []
              : testCase.expected === "read"
                ? ["memory:read"]
                : ["memory:read", "memory:write"];
          const admission = yield* AdapterInfrastructure.ProviderMemoryAdmission;
          assert.deepEqual(
            yield* admission.currentPolicy(threadId),
            yield* manager.currentMemoryPolicy!(threadId),
          );
          assert.equal((yield* admission.currentPolicy(threadId)).grant, testCase.expected);
          const fenced = yield* admission.fence(config);
          assert.deepEqual(
            fenced?.grantedScopes?.filter((scope) => scope.startsWith("memory:")),
            expectedScopes,
          );
          const publication = (yield* Queue.takeAll(issued)).at(-1);
          assert.isDefined(publication);
          assert.deepEqual(
            publication!.grantedScopes.filter((scope) => scope.startsWith("memory:")),
            expectedScopes,
          );
          assert.equal(
            (yield* projections.getThreadProjection(threadId)).runs.find(
              (candidate) => candidate.id === startRunId,
            )?.status,
            "running",
          );
          assert.equal((yield* Ref.get(state)).openCount, 1);
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerTest({
              state,
              idleTimeoutMs: 1000,
              serverSettingsLayer: settingsLayer,
              projectionReads,
              onTurnInput,
            }),
            settingsLayer,
            Layer.effect(
              Orchestrator.OrchestratorV2,
              Effect.gen(function* () {
                return yield* Orchestrator.OrchestratorV2;
              }),
            ).pipe(
              Layer.provide(
                ProviderReplayHarness.layerWithRegistry(
                  { name: "memory-start-admission" },
                  ProviderAdapterRegistry.layerFromAdapters([
                    {
                      instanceId: modelSelection.instanceId,
                      driver: ProviderDriverKind.make("codex"),
                      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
                      planSelectionTransition: () =>
                        Effect.succeed({ type: "apply_on_next_turn" as const }),
                      openSession: () => Effect.die("unused replay provider"),
                    } as ProviderAdapter.ProviderAdapterV2["Service"],
                  ]),
                  { databaseLayer: layerTestDatabase, runEffectWorker: false },
                ),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect("keeps an idle instance reserved until native session close completes", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const routes = yield* CodexRoutes.CodexRouteState;
      const eventSink = yield* EventSink.EventSinkV2;
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const threadId = ThreadId.make("home-route-session-lease");
      const providerSessionId = yield* allocator.allocate.providerSession({
        threadId,
        providerInstanceId: modelSelection.instanceId,
      });
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({
            idAllocator: allocator,
            threadId,
            now: yield* DateTime.now,
          }),
        ],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const current = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [modelSelection.instanceId]: { driver: ProviderDriverKind.make("codex"), config: {} },
        },
      };
      const next = {
        ...current,
        providerInstances: {
          [modelSelection.instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            config: { modelRoute: "opencodex" },
          },
        },
      };
      const busy = yield* routes.validate(current, next).pipe(Effect.result);
      assert.equal(busy._tag, "Failure");
      if (busy._tag === "Failure") assert.equal(busy.failure.code, "provider_instance_busy");
      yield* manager.close(providerSessionId);
      yield* routes.validate(current, next);
    }).pipe(
      Effect.provide(
        layerTest({ state, idleTimeoutMs: 60_000 }).pipe(
          Layer.provideMerge(CodexRoutes.layerState),
        ),
      ),
    );
  }),
);

it.effect("drops a Home instance reservation after open fails", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const routes = yield* CodexRoutes.CodexRouteState;
      const eventSink = yield* EventSink.EventSinkV2;
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const threadId = ThreadId.make("home-open-failure");
      const providerSessionId = yield* allocator.allocate.providerSession({
        threadId,
        providerInstanceId: modelSelection.instanceId,
      });
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({
            idAllocator: allocator,
            threadId,
            now: yield* DateTime.now,
          }),
        ],
      });
      const outcome = yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(outcome));
      const current = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [modelSelection.instanceId]: { driver: ProviderDriverKind.make("codex"), config: {} },
        },
      };
      const next = {
        ...current,
        providerInstances: {
          [modelSelection.instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            config: { modelRoute: "opencodex" },
          },
        },
      };
      yield* routes.validate(current, next);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen: () => Effect.die("Simulated native open failure"),
        }).pipe(Layer.provideMerge(CodexRoutes.layerState)),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a thread's MCP token through a memory policy change mid-turn",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const settingsLayer = ServerSettings.layerTest();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const configs = yield* McpProviderSessions.McpProviderSessions;
        const settings = yield* ServerSettings.ServerSettingsService;
        const projection = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("thread-memory-toggle-mid-turn");
        const now = yield* DateTime.now;
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
          memoryGrantCeiling: null,
        });
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        yield* runtime.startTurn({
          appThread: (yield* projection.getThreadProjection(threadId)).thread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId }),
          providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "long coordinator turn",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        // The provider process holds this header for the rest of its turn.
        const held = yield* configs.read(threadId);
        assert.isDefined(held);
        const heldToken = held!.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.include((yield* registry.resolve(heldToken))?.grantedScopes ?? [], "memory:read");

        const memoryOff = yield* Deferred.make<void>();
        yield* manager.mcpCredentialRotations!.pipe(
          Stream.filter((event) => event.memoryPolicy.grant === "none"),
          Stream.take(1),
          Stream.runForEach(() => Deferred.succeed(memoryOff, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* settings.updateSettings({ enableAgentMemoryAccess: false });
        // Before the manager re-prepares, the stale epoch withdraws only memory.
        const drifted = yield* registry.resolve(heldToken);
        assert.isDefined(drifted, "a memory policy change must not end the thread's credential");
        assert.notInclude(drifted?.grantedScopes ?? [], "memory:read");
        assert.isFalse(drifted?.capabilities.has("memory"));
        assert.isTrue(drifted?.capabilities.has("orchestration"));

        yield* Deferred.await(memoryOff);
        const renewed = yield* configs.read(threadId);
        assert.equal(renewed?.authorizationHeader, held!.authorizationHeader);
        assert.equal(renewed?.providerSessionId, held!.providerSessionId);
        const scope = yield* registry.resolve(heldToken);
        assert.deepEqual(scope?.grantedScopes, ["orchestration:read"]);
        assert.equal(scope?.memoryPolicy?.grant, "none");

        yield* settings.updateSettings({ enableAgentMemoryAccess: true });
        yield* manager.prepareMcpSession!({
          threadId,
          providerInstanceId: modelSelection.instanceId,
          memoryGrantCeiling: null,
        });
        assert.include((yield* registry.resolve(heldToken))?.grantedScopes ?? [], "memory:write");

        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* registry.resolve(heldToken));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerTest({ state, idleTimeoutMs: 1000, serverSettingsLayer: settingsLayer }),
            settingsLayer,
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "ProviderSessionManagerV2 memory admission refuses a config whose authority changed during its final check",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const settingsLayer = ServerSettings.layerTest();
      const beforeGetThread = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const configs = yield* McpProviderSessions.McpProviderSessions;
        const admission = yield* AdapterInfrastructure.ProviderMemoryAdmission;
        const threadId = ThreadId.make("thread-admission-during-renewal");
        const now = yield* DateTime.now;
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
          memoryGrantCeiling: null,
        });
        const before = (yield* configs.read(threadId))!;
        assert.include((yield* admission.fence(before))?.grantedScopes ?? [], "memory:write");

        // A fence reads the thread three times: attachment, policy, final attachment.
        // Pause the last one.
        const paused = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let calls = 0;
        yield* Ref.set(
          beforeGetThread,
          Effect.suspend(() =>
            ++calls === 3
              ? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
          ),
        );
        const fenced = yield* admission
          .fence(before)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(paused);
        yield* Ref.set(beforeGetThread, Effect.void);
        yield* manager.prepareMcpSession!({
          threadId,
          providerInstanceId: modelSelection.instanceId,
          memoryGrantCeiling: null,
          readOnly: true,
        });
        const after = (yield* configs.read(threadId))!;
        assert.equal(after.authorizationHeader, before.authorizationHeader);
        assert.notEqual(after.credentialGeneration, before.credentialGeneration);
        yield* Deferred.succeed(resume, undefined);
        assert.isUndefined(yield* Fiber.join(fenced));
        assert.notInclude((yield* admission.fence(after))?.grantedScopes ?? [], "memory:write");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerTest({
              state,
              idleTimeoutMs: 1000,
              serverSettingsLayer: settingsLayer,
              beforeGetThread,
            }),
            settingsLayer,
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "ProviderSessionManagerV2 invalidates only errored threads and keeps reusable session errors cached",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const openCachedRuntime = Effect.fnUntraced(function* (
          threadId: ThreadId,
          sharedSessionId?: ProviderSessionId,
        ) {
          const providerSessionId =
            sharedSessionId ??
            (yield* idAllocator.allocate.providerSession({
              providerInstanceId: modelSelection.instanceId,
              threadId,
            }));
          yield* eventSink.write({
            events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
          });
          const runtime = yield* manager.open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          const providerThread = makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: String(threadId),
          });
          const resume = runtime.resumeThread({
            providerThread,
            threadId,
            modelSelection,
            runtimePolicy,
          });
          yield* resume;
          yield* resume;
          return { runtime, providerThread, resume };
        });
        const failed = yield* openCachedRuntime(ThreadId.make("idle-failed-runtime"));
        const healthy = yield* openCachedRuntime(ThreadId.make("idle-healthy-runtime"));
        const sibling = yield* openCachedRuntime(
          ThreadId.make("idle-healthy-sibling"),
          failed.runtime.providerSessionId,
        );
        assert.strictEqual(sibling.runtime, failed.runtime);
        assert.equal((yield* Ref.get(state)).openCount, 2);
        assert.equal((yield* Ref.get(state)).resumeCount, 3);

        const queue = (yield* Ref.get(state)).eventQueues.get(
          String(failed.runtime.providerSessionId),
        );
        assert.isDefined(queue);
        const publish = Effect.fnUntraced(function* (
          event: ProviderAdapter.ProviderAdapterV2Event,
        ) {
          const subscription = yield* failed.runtime.subscribeEvents!;
          yield* Queue.offer(queue!, event);
          // Observing the exact event ensures the manager has handled it before resuming.
          assert.deepEqual(yield* subscription.events.pipe(Stream.runHead), Option.some(event));
        });
        const countRawResumes = Effect.fnUntraced(function* (cached: typeof failed) {
          const before = (yield* Ref.get(state)).resumeCount;
          yield* cached.resume;
          return (yield* Ref.get(state)).resumeCount - before;
        });
        yield* publish({
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread: failed.providerThread,
        });
        yield* publish({
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: {
            ...failed.runtime.providerSession,
            status: "error",
            lastError: "Reusable turn failure",
          },
        });
        const afterSessionError = {
          reusableThread: yield* countRawResumes(failed),
          siblingThread: yield* countRawResumes(sibling),
        };

        yield* publish({
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread: { ...failed.providerThread, status: "error" },
        });
        const afterThreadError = {
          healthyRuntime: yield* countRawResumes(healthy),
          siblingThread: yield* countRawResumes(sibling),
          failedThread: yield* countRawResumes(failed),
          failedThreadAgain: yield* countRawResumes(failed),
        };
        assert.deepEqual(
          { afterSessionError, afterThreadError },
          {
            afterSessionError: { reusableThread: 0, siblingThread: 0 },
            afterThreadError: {
              healthyRuntime: 0,
              siblingThread: 0,
              failedThread: 1,
              failedThreadAgain: 0,
            },
          },
        );
      });

      yield* effect.pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 1000 })));
    }),
);
