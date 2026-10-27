import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  type PreparedConnection,
} from "@goat/client-runtime/connection";
import { Persistence } from "@goat/client-runtime/platform";
import {
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "@goat/client-runtime/state/threads";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadDetailSnapshot,
} from "@goat/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";

import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import type { WsRpcProtocolClient } from "../../../../packages/client-runtime/src/rpc/protocol";
import type { RpcSession } from "@goat/client-runtime/rpc/session";
import { threadRouteIsHydrating } from "../features/threads/thread-route-hydration";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const testRuntime = vi.hoisted(() => ({
  layer: undefined as
    | Layer.Layer<
        | EnvironmentRegistry.EnvironmentRegistry
        | Persistence.EnvironmentCacheStore
        | ThreadSnapshotLoader
      >
    | undefined,
}));

vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.suspend(() => {
        if (!testRuntime.layer) throw new Error("Test connection layer missing");
        return testRuntime.layer;
      }),
    ),
  };
});
vi.mock("../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("./shell", () => ({ environmentShell: {} }));
vi.mock("./presentation", () => ({ environmentPresentations: {} }));

const environmentId = EnvironmentId.make("environment-1");
const threadId = v2Projection.thread.id;
const threadKey = `${environmentId}:${threadId}`;
const creation: QueuedThreadMessage = {
  environmentId,
  threadId,
  messageId: MessageId.make("message-1"),
  commandId: CommandId.make("command-1"),
  text: "Fix the flaky login test",
  attachments: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  creation: {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "local",
    branch: "main",
    worktreePath: null,
  },
  createdAt: "2026-08-24T12:00:00.000Z",
};
const snapshot: OrchestrationV2ThreadDetailSnapshot = {
  snapshotSequence: 7,
  projection: v2Projection,
};

const setup = Effect.fn("MobileThreadTest.setup")(function* (options?: {
  readonly cacheRead?: Effect.Effect<Option.Option<OrchestrationV2ThreadDetailSnapshot>>;
}) {
  vi.resetModules();
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "Test environment",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  });
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: () => Stream.never,
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({} as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: target.wsBaseUrl,
        httpAuthorization: null,
        target,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const registryService = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: () => Effect.die("Unexpected registration"),
    registerPlatform: () => Effect.die("Unexpected registration"),
    reconcilePlatform: () => Effect.die("Unexpected reconciliation"),
    remove: () => Effect.die("Unexpected removal"),
    removeRoute: () => Effect.die("Unexpected removal"),
    reorderRoutes: () => Effect.die("Unexpected reorder"),
    removeRelayEnvironments: () => Effect.die("Unexpected removal"),
    retryNow: () => Effect.void,
    setEnabled: () => Effect.die("Unexpected toggle"),
    setCompatibility: () => Effect.die("Unexpected compatibility update"),
    state: () => SubscriptionRef.get(supervisor.state),
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
    run: (_id, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  });
  const availableThreads = new Set<ThreadId>();
  testRuntime.layer = Layer.mergeAll(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registryService),
    Layer.succeed(
      Persistence.EnvironmentCacheStore,
      Persistence.EnvironmentCacheStore.of({
        loadShellMeta: () => Effect.succeedNone,
        saveShellMeta: () => Effect.void,
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => options?.cacheRead ?? Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ThreadSnapshotLoader,
      ThreadSnapshotLoader.of({
        load: (_prepared, id) =>
          Effect.sync(() =>
            availableThreads.has(id)
              ? { _tag: "present" as const, snapshot }
              : { _tag: "missing" as const },
          ),
      }),
    ),
  );
  const [registryModule, threads, outbox, pending, sharedThreads] = yield* Effect.promise(() =>
    Promise.all([
      import("./atom-registry"),
      import("./threads"),
      import("./thread-outbox"),
      import("./pending-thread-creation"),
      import("@goat/client-runtime/state/threads"),
    ]),
  );
  const registry = registryModule.appAtomRegistry;
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const stateAtom = threads.environmentThreadDetails.stateAtom({ environmentId, threadId });
  const observe = (predicate: (state: EnvironmentThreadState) => boolean) =>
    AtomRegistry.toStream(registry, stateAtom).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return {
    registry,
    threads,
    outbox,
    pending,
    availableThreads,
    stateAtom,
    observe,
    emptyState: sharedThreads.EMPTY_ENVIRONMENT_THREAD_STATE,
  };
});

describe("startOpeningEnvironmentThread", () => {
  for (const outcome of ["queued", "failed"] as const) {
    it.effect(
      `opens the delivered thread after ${outcome} creation without retaining an early miss (#1952)`,
      () =>
        Effect.gen(function* () {
          const h = yield* setup();
          vi.useFakeTimers();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              vi.clearAllTimers();
              vi.useRealTimers();
            }),
          );
          if (outcome === "queued") {
            h.registry.set(h.outbox.threadOutboxManager.queuedMessagesByThreadKeyAtom, {
              [threadKey]: [creation],
            });
          } else {
            h.registry.set(h.pending.pendingThreadCreationOutcomesAtom, {
              [threadKey]: { kind: "failed", message: creation, reason: "Checkout failed" },
            });
          }
          h.threads.startOpeningEnvironmentThread(environmentId, threadId);
          // Drain scheduled atom work while the server still answers missing.
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
          h.availableThreads.add(threadId);
          h.registry.set(h.outbox.threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
          h.registry.set(h.pending.pendingThreadCreationOutcomesAtom, {
            [threadKey]: { kind: "delivered", message: creation },
          });
          h.threads.startOpeningEnvironmentThread(environmentId, threadId);
          const state = yield* h.observe(
            (value) => value.status === "live" || value.status === "deleted",
          );
          expect(state.status).toBe("live");
          expect(Option.getOrThrow(state.data).thread).toEqual(v2Projection.thread);
          yield* Effect.promise(() => vi.runAllTimersAsync());
        }),
    );
  }

  it.effect("opens an existing thread with a queued follow-up message", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      vi.useFakeTimers();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          vi.clearAllTimers();
          vi.useRealTimers();
        }),
      );
      h.availableThreads.add(threadId);
      const { creation: _creation, ...followUp } = creation;
      h.registry.set(h.outbox.threadOutboxManager.queuedMessagesByThreadKeyAtom, {
        [threadKey]: [followUp],
      });
      h.threads.startOpeningEnvironmentThread(environmentId, threadId);
      const state = yield* h.observe((value) => value.status === "live");
      expect(Option.getOrThrow(state.data).thread.id).toBe(threadId);
      yield* Effect.promise(() => vi.runAllTimersAsync());
    }),
  );

  it.effect(
    "keeps waiting after shell failure until the deferred original detail cache arrives (#1952)",
    () =>
      Effect.gen(function* () {
        const cached = yield* Deferred.make<Option.Option<OrchestrationV2ThreadDetailSnapshot>>();
        const reading = yield* Deferred.make<void>();
        const h = yield* setup({
          cacheRead: Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(cached)),
          ),
        });
        const unmount = h.registry.mount(h.stateAtom);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        yield* Deferred.await(reading);
        const pending = h.registry.get(h.stateAtom);
        expect(pending).toBe(h.emptyState);
        const hydrating = (detail: EnvironmentThreadState) =>
          threadRouteIsHydrating({
            isLoadingConnections: false,
            environmentRegistered: true,
            localCacheRead: detail !== h.emptyState,
            connectionState: "connected",
            shellStatus: "empty",
            shellHasError: true,
            detailStatus: detail.status,
            detailHasError: Option.isSome(detail.error),
          });
        expect(hydrating(pending)).toBe(true);
        yield* Deferred.succeed(cached, Option.some(snapshot));
        const loaded = yield* h.observe((value) => Option.isSome(value.data));
        expect(Option.getOrThrow(loaded.data).thread.id).toBe(threadId);
        expect(hydrating(loaded)).toBe(false);
      }),
  );
});
