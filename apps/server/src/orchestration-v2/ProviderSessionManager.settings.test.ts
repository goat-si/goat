import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Test fixture paths.
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as AdapterInfrastructure from "../provider/ProviderOrchestrationAdapterInfrastructure.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  layerTestEventSink,
  layerTestStores,
} from "./ProviderSessionManager.persistence.testkit.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { makeCodexModelArrivals } from "./Adapters/CodexModelArrivals.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;
const threadA = ThreadId.make("thread-settings-a");
const threadB = ThreadId.make("thread-settings-b");
const threadC = ThreadId.make("thread-settings-c");
/** A retiring process stops within one probe after its work ends; idle sessions wait 30 minutes. */
const retireProbe = "5 seconds";

interface Fixture {
  readonly opens: Ref.Ref<number>;
  readonly closed: Queue.Queue<void>;
  /** What the provider instance looks like now; a settings edit changes the key. */
  readonly instance: { sessionConfigKey: string; present: boolean };
  readonly changes: PubSub.PubSub<void>;
  readonly turnStarted: Deferred.Deferred<void>;
  readonly endTurn: Deferred.Deferred<void>;
  /** Work the process holds outside turns, such as an active goal: what it knows, and what Codex confirms. */
  readonly liveWork: { held: boolean; confirm: Effect.Effect<boolean> };
  /** Codex's model catalog on disk; each process knows the catalog as it was when it started. */
  readonly catalog: Array<string>;
  /** Set when the next open reconnects a process kept from before a restart that knew only these. */
  keptProcessKnows: ReadonlyArray<string> | undefined;
  /** Commands or tools still running in the process outside any turn. */
  backgroundWork: boolean;
  /** Runs while the manager reads that state, as a provider event arriving mid-check would. */
  duringBackgroundProbe: Effect.Effect<void>;
  /** Catalog models a freshly started process still does not list, as with a project's own catalog. */
  readonly freshProcessLacks: Array<string>;
  /** The process cannot answer for its model list, as a runtime without model/list. */
  listingUnavailable: boolean;
  /** Runs while the process is asked for its models, before it answers. */
  duringModelStatus: Effect.Effect<void>;
  /** When set, processes answer with Codex's real model check over this listing of theirs. */
  listServed: Effect.Effect<ReadonlyArray<string>> | undefined;
  /** When set, processes read this `model_catalog_json` file at startup, as Codex does. */
  catalogFile:
    | { readonly filename: string; readonly fileSystem: FileSystem.FileSystem }
    | undefined;
  /** Runs before the manager stops a session's armed idle timer to re-arm it. */
  beforeIdleInterrupt: Effect.Effect<void>;
}

const makeFixture = Effect.gen(function* () {
  const fixture: Fixture = {
    opens: yield* Ref.make(0),
    closed: yield* Queue.unbounded<void>(),
    instance: { sessionConfigKey: "settings-1", present: true },
    changes: yield* PubSub.unbounded<void>(),
    turnStarted: yield* Deferred.make<void>(),
    endTurn: yield* Deferred.make<void>(),
    liveWork: { held: false, confirm: Effect.void.pipe(Effect.as(false)) },
    catalog: [modelSelection.model],
    keptProcessKnows: undefined,
    backgroundWork: false,
    duringBackgroundProbe: Effect.void,
    freshProcessLacks: [],
    listingUnavailable: false,
    duringModelStatus: Effect.void,
    listServed: undefined,
    catalogFile: undefined,
    beforeIdleInterrupt: Effect.void,
  };
  fixture.liveWork.confirm = Effect.sync(() => fixture.liveWork.held);
  return fixture;
});

const unused = (detail: string) =>
  Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));

const makeAdapter = (fixture: Fixture): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId,
  driver,
  get sessionConfigKey() {
    return fixture.instance.sessionConfigKey;
  },
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) =>
    Effect.gen(function* () {
      yield* Ref.update(fixture.opens, (count) => count + 1);
      yield* Effect.addFinalizer(() => Queue.offer(fixture.closed, undefined));
      const now = yield* DateTime.now;
      // A kept process read its catalog in an earlier run, so what was offered at this open says nothing.
      const offeredAtStart = new Set(fixture.keptProcessKnows === undefined ? fixture.catalog : []);
      const known = new Set(
        fixture.keptProcessKnows ??
          fixture.catalog.filter((model) => !fixture.freshProcessLacks.includes(model)),
      );
      fixture.keptProcessKnows = undefined;
      const catalogModels = () =>
        fixture.catalog.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null }));
      const { catalogFile } = fixture;
      const arrivals =
        fixture.listServed === undefined && catalogFile === undefined
          ? undefined
          : makeCodexModelArrivals({
              atStart: catalogModels(),
              offered: Effect.sync(catalogModels),
              listServed: Effect.suspend(
                () => fixture.listServed ?? Effect.succeed(fixture.catalog),
              ),
              startedAtMs: yield* Clock.currentTimeMillis,
              ...(catalogFile && {
                catalog: {
                  cwd: "/",
                  home: undefined,
                  fileSystem: catalogFile.fileSystem,
                  readConfig: Effect.succeed({
                    config: { model_catalog_json: catalogFile.filename },
                  }),
                },
              }),
            });
      return {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: process.cwd(),
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.never,
        backgroundTasksEndWithProcess: true,
        hasPendingBackgroundWork: Effect.suspend(() => fixture.duringBackgroundProbe).pipe(
          Effect.andThen(Effect.sync(() => fixture.backgroundWork)),
        ),
        holdsLiveWork: ({ pastPinCeiling }) =>
          pastPinCeiling ? fixture.liveWork.confirm : Effect.succeed(fixture.liveWork.held),
        modelStatus: (model, options) =>
          arrivals?.(model, options) ??
          Effect.suspend(() => fixture.duringModelStatus).pipe(
            Effect.andThen(
              Effect.sync(() =>
                !fixture.catalog.includes(model) || known.has(model)
                  ? "ready"
                  : fixture.listingUnavailable
                    ? "unconfirmed"
                    : offeredAtStart.has(model)
                      ? "missing"
                      : "predated",
              ),
            ),
          ),
        ensureThread: () => unused("ensureThread"),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        // The turn runs until the test ends it; ending it fails the start, which settles it.
        startTurn: () =>
          Deferred.succeed(fixture.turnStarted, undefined).pipe(
            Effect.andThen(Deferred.await(fixture.endTurn)),
            Effect.andThen(unused("turn ended")),
          ),
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => unused("readThreadSnapshot"),
        rollbackThread: () => unused("rollbackThread"),
        forkThread: () => unused("forkThread"),
      } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
    }),
});

const mcpRegistry = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make({}),
).pipe(
  Layer.provide(
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43124),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
  ),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("session-settings-test")),
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const layer = (fixture: Fixture) => {
  const instances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - Optional instances require undefined rather than void.
    getInstance: () => Effect.succeed(undefined),
    subscribeChanges: PubSub.subscribe(fixture.changes),
  });
  const adapter = makeAdapter(fixture);
  const adapters = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: (id) =>
        fixture.instance.present
          ? Effect.succeed(adapter)
          : Effect.fail(
              new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId: id }),
            ),
      list: () => Effect.succeed([instanceId]),
    }),
  );
  const ingestor = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        instances,
        layerTestEventSink,
        IdAllocator.layer,
        layerTestStores,
        ThreadCommandExecutor.layer,
        Layer.mock(GitVcsDriver.GitVcsDriver)({ resolveBranchName: () => Effect.succeed(null) }),
      ),
    ),
  );
  return Layer.mergeAll(
    layerTestEventSink,
    IdAllocator.layer,
    layerTestStores,
    ProviderSessionManager.layerWithOptions({
      beforeIdleFiberInterrupt: Effect.suspend(() => fixture.beforeIdleInterrupt),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          adapters,
          instances,
          McpProviderSessions.layer,
          AdapterInfrastructure.layerMemoryAdmission,
          CommandOutputHub.layer.pipe(
            Layer.provide(Layer.merge(layerTestEventSink, layerTestStores)),
          ),
          layerTestEventSink,
          IdAllocator.layer,
          ingestor,
          mcpRegistry,
          layerTestStores,
        ),
      ),
    ),
  ).pipe(Layer.provide(NodeServices.layer));
};

const appThread = (
  threadId: ThreadId,
  projectId: OrchestrationV2AppThread["projectId"],
  now: DateTime.Utc,
) =>
  ({
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Settings",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  }) satisfies OrchestrationV2AppThread;

/** Two threads on the instance's shared Codex session, as GOAT places them by default. */
const sharedSession = Effect.gen(function* () {
  const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const now = yield* DateTime.now;
  const projectId = yield* idAllocator.allocate.project({ fixtureName: "session-settings" });
  const threads = {
    [threadA]: appThread(threadA, projectId, now),
    [threadB]: appThread(threadB, projectId, now),
    [threadC]: appThread(threadC, projectId, now),
  };
  for (const thread of Object.values(threads))
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId: thread.id }),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
  const runOf = (threadId: ThreadId) => idAllocator.derive.run({ threadId, ordinal: 1 });
  // What the turn-start service does when a start attempt exits, registered or not.
  const endStart = (threadId: ThreadId) =>
    manager.settleTurnStart({ threadId, runId: runOf(threadId) });
  const providerSessionId: ProviderSessionId = idAllocator.derive.providerSession({
    providerInstanceId: instanceId,
  });
  const open = (threadId: ThreadId, model = modelSelection.model, startsTurn = true) =>
    manager.open({
      threadId,
      providerSessionId,
      modelSelection: { instanceId, model },
      runtimePolicy,
      startsTurn,
      runId: runOf(threadId),
    });
  const runTurn = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const runtime = yield* open(threadId);
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      return yield* runtime.startTurn({
        appThread: threads[threadId]!,
        threadId,
        runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
        rootNodeId: idAllocator.derive.rootNode({ runId }),
        providerThread: {
          id: idAllocator.derive.providerThread({ driver, nativeThreadId: `native-${threadId}` }),
          driver,
          providerInstanceId: instanceId,
          providerSessionId,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: { driver, nativeId: `native-${threadId}`, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
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
  return { manager, providerSessionId, open, runTurn, endStart };
});

const editSettings = (fixture: Fixture, patch: Partial<Fixture["instance"]>) =>
  Effect.sync(() => Object.assign(fixture.instance, patch)).pipe(
    Effect.andThen(PubSub.publish(fixture.changes, undefined)),
  );

it.effect("a new thread after a settings edit starts a new Codex process", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { open } = yield* sharedSession;
      yield* open(threadA);
      fixture.instance.sessionConfigKey = "settings-2";
      yield* open(threadB);
      assert.strictEqual(yield* Ref.get(fixture.opens), 2);
      assert.strictEqual(yield* Queue.size(fixture.closed), 1);
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect("turning the provider off stops its idle process", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { manager, open, providerSessionId } = yield* sharedSession;
      yield* open(threadA);
      yield* editSettings(fixture, { sessionConfigKey: "settings-disabled" });
      yield* Queue.take(fixture.closed);
      assert.isFalse(yield* manager.isLive(providerSessionId));
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect("deleting the provider instance stops its idle process", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { manager, open, providerSessionId } = yield* sharedSession;
      yield* open(threadA);
      yield* editSettings(fixture, { present: false });
      yield* Queue.take(fixture.closed);
      assert.isFalse(yield* manager.isLive(providerSessionId));
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect(
  "a running turn finishes on the old process, which then stops; new turns wait for it",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const { manager, open, runTurn, providerSessionId } = yield* sharedSession;
        const turn = yield* runTurn(threadA).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(fixture.turnStarted);
        yield* editSettings(fixture, { sessionConfigKey: "settings-2" });

        const refused = yield* open(threadB).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(refused));
        assert.include(String(Exit.isFailure(refused) ? refused.cause : ""), "settings changed");
        // The thread whose turn is still running keeps reaching it.
        yield* open(threadA);
        assert.isTrue(yield* manager.isLive(providerSessionId));
        assert.strictEqual(yield* Queue.size(fixture.closed), 0);

        yield* Deferred.succeed(fixture.endTurn, undefined);
        yield* Fiber.join(turn);
        yield* TestClock.adjust(retireProbe);
        yield* Queue.take(fixture.closed);
        yield* open(threadB);
        assert.strictEqual(yield* Ref.get(fixture.opens), 2);
      }).pipe(Effect.provide(layer(fixture)));
    }),
);

it.effect("turning the provider back on with the same settings keeps its process", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { manager, open, runTurn, providerSessionId } = yield* sharedSession;
      const turn = yield* runTurn(threadA).pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(fixture.turnStarted);
      fixture.instance.sessionConfigKey = "settings-disabled";
      assert.isTrue(Exit.isFailure(yield* open(threadB).pipe(Effect.exit)));
      fixture.instance.sessionConfigKey = "settings-1";
      yield* open(threadB);

      yield* Deferred.succeed(fixture.endTurn, undefined);
      yield* Fiber.join(turn);
      yield* TestClock.adjust(retireProbe);
      assert.isTrue(yield* manager.isLive(providerSessionId));
      assert.strictEqual(yield* Ref.get(fixture.opens), 1);
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect("an active goal keeps the old process until it ends", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { manager, open, providerSessionId } = yield* sharedSession;
      yield* open(threadA);
      fixture.liveWork.held = true;
      fixture.instance.sessionConfigKey = "settings-2";
      const refused = yield* open(threadB).pipe(Effect.exit);
      assert.include(
        String(Exit.isFailure(refused) ? refused.cause : ""),
        "active goal, a subagent or a pending approval",
      );
      yield* TestClock.adjust(retireProbe);
      assert.isTrue(yield* manager.isLive(providerSessionId));

      fixture.liveWork.held = false;
      yield* TestClock.adjust(retireProbe);
      yield* Queue.take(fixture.closed);
      yield* open(threadB);
      assert.strictEqual(yield* Ref.get(fixture.opens), 2);
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect("restoring the settings does not wait for Codex to confirm a goal", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const confirming = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { manager, open, providerSessionId } = yield* sharedSession;
      yield* open(threadA);
      fixture.liveWork.held = true;
      fixture.liveWork.confirm = Deferred.succeed(confirming, undefined).pipe(
        Effect.andThen(Effect.never),
      );
      fixture.instance.sessionConfigKey = "settings-2";
      assert.isTrue(Exit.isFailure(yield* open(threadB).pipe(Effect.exit)));
      yield* TestClock.adjust(retireProbe);
      yield* Deferred.await(confirming);

      fixture.instance.sessionConfigKey = "settings-1";
      yield* open(threadB);
      assert.isTrue(yield* manager.isLive(providerSessionId));
      assert.strictEqual(yield* Ref.get(fixture.opens), 1);
    }).pipe(Effect.provide(layer(fixture)));
  }),
);
const addedModel = "combo/deepseek-flash-pool";

/** A turn on the thread that ran and finished, so its open no longer counts as a start in flight. */
const finishTurn = <E>(
  fixture: Fixture,
  runTurn: (threadId: ThreadId) => Effect.Effect<void, E>,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const turn = yield* runTurn(threadId).pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(fixture.turnStarted);
    yield* Deferred.succeed(fixture.endTurn, undefined);
    yield* Fiber.join(turn);
  });

it.effect("a turn on a model added after Codex started opens a fresh process when it is idle", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { manager, open, runTurn, providerSessionId } = yield* sharedSession;
      yield* finishTurn(fixture, runTurn, threadA);
      fixture.catalog.push(addedModel);
      yield* open(threadB, addedModel);
      assert.strictEqual(yield* Ref.get(fixture.opens), 2);
      assert.strictEqual(yield* Queue.size(fixture.closed), 1);
      assert.isTrue(yield* manager.isLive(providerSessionId));
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect(
  "while work runs, a model the process predates is refused by name and nothing is stopped",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const { open, runTurn } = yield* sharedSession;
        const turn = yield* runTurn(threadA).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(fixture.turnStarted);
        fixture.catalog.push(addedModel);

        const refused = yield* open(threadB, addedModel).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(refused));
        assert.include(String(Exit.isFailure(refused) ? refused.cause : ""), addedModel);
        // Other turns on models the process knows still start; nothing drains for the new one.
        yield* open(threadB);
        assert.strictEqual(yield* Queue.size(fixture.closed), 0);
        assert.strictEqual(yield* Ref.get(fixture.opens), 1);

        yield* Deferred.succeed(fixture.endTurn, undefined);
        yield* Fiber.join(turn);
        yield* open(threadB, addedModel);
        assert.strictEqual(yield* Ref.get(fixture.opens), 2);
        assert.strictEqual(yield* Queue.size(fixture.closed), 1);
      }).pipe(Effect.provide(layer(fixture)));
    }),
);

/** Codex's `model_catalog_json` with the session model's context window, written at `writtenAtMs`. */
const writeCatalog = (filename: string, contextWindow: number, writtenAtMs: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const models = [{ slug: modelSelection.model, context_window: contextWindow }];
    yield* fs.writeFileString(filename, JSON.stringify({ models }));
    yield* fs.utimes(filename, writtenAtMs / 1000, writtenAtMs / 1000);
  });

/** A fixture whose processes read a catalog file written before the clock reaches 10 seconds. */
const catalogFixture = Effect.gen(function* () {
  const fixture = yield* makeFixture;
  const fileSystem = yield* FileSystem.FileSystem;
  const filename = NodePath.join(yield* fileSystem.makeTempDirectoryScoped(), "catalog.json");
  yield* writeCatalog(filename, 272_000, 1_000);
  fixture.catalogFile = { filename, fileSystem };
  yield* TestClock.adjust("10 seconds");
  // The catalog sync rewrites the file at 20 seconds; later opens start after it.
  const changeCatalog = writeCatalog(filename, 1_048_576, 20_000).pipe(
    Effect.andThen(TestClock.adjust("15 seconds")),
  );
  return { fixture, changeCatalog };
});

it.effect(
  "a turn after the catalog changed a model's details opens a fresh process when Codex is idle",
  () =>
    Effect.gen(function* () {
      const { fixture, changeCatalog } = yield* catalogFixture;
      yield* Effect.gen(function* () {
        const { manager, open, runTurn, providerSessionId } = yield* sharedSession;
        yield* finishTurn(fixture, runTurn, threadA);
        yield* changeCatalog;
        yield* open(threadB);
        assert.strictEqual(yield* Ref.get(fixture.opens), 2);
        assert.strictEqual(yield* Queue.size(fixture.closed), 1);
        assert.isTrue(yield* manager.isLive(providerSessionId));
        // The new process read the changed catalog, so the next turn keeps it.
        yield* open(threadC);
        assert.strictEqual(yield* Ref.get(fixture.opens), 2);
      }).pipe(Effect.provide(layer(fixture)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "while work runs, a model whose catalog details changed still starts its turn and nothing stops",
  () =>
    Effect.gen(function* () {
      const { fixture, changeCatalog } = yield* catalogFixture;
      yield* Effect.gen(function* () {
        const { open, runTurn } = yield* sharedSession;
        const turn = yield* runTurn(threadA).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(fixture.turnStarted);
        yield* changeCatalog;

        yield* open(threadB);
        assert.strictEqual(yield* Ref.get(fixture.opens), 1);
        assert.strictEqual(yield* Queue.size(fixture.closed), 0);

        // Once the running turn ends, the next turn restarts the process with the new catalog.
        yield* Deferred.succeed(fixture.endTurn, undefined);
        yield* Fiber.join(turn);
        yield* open(threadB);
        assert.strictEqual(yield* Ref.get(fixture.opens), 2);
        assert.strictEqual(yield* Queue.size(fixture.closed), 1);
      }).pipe(Effect.provide(layer(fixture)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a model no fresh process would know never restarts or refuses", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { open } = yield* sharedSession;
      yield* open(threadA);
      yield* open(threadB, "custom/not-in-the-catalog");
      assert.strictEqual(yield* Ref.get(fixture.opens), 1);
      assert.strictEqual(yield* Queue.size(fixture.closed), 0);
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect("running commands keep a process a newer model needs; only that turn is refused", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { open, runTurn } = yield* sharedSession;
      yield* finishTurn(fixture, runTurn, threadA);
      fixture.backgroundWork = true;
      fixture.catalog.push(addedModel);
      const refused = yield* open(threadB, addedModel).pipe(Effect.exit);
      assert.include(String(Exit.isFailure(refused) ? refused.cause : ""), addedModel);
      assert.strictEqual(yield* Queue.size(fixture.closed), 0);

      fixture.backgroundWork = false;
      yield* open(threadB, addedModel);
      assert.strictEqual(yield* Ref.get(fixture.opens), 2);
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect(
  "a process kept from before a restart refuses a newer model on its first open and keeps running",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const { manager, open, providerSessionId } = yield* sharedSession;
        fixture.catalog.push(addedModel);
        fixture.keptProcessKnows = [modelSelection.model];
        const refused = yield* open(threadA, addedModel).pipe(Effect.exit);
        assert.include(String(Exit.isFailure(refused) ? refused.cause : ""), addedModel);
        assert.isTrue(yield* manager.isLive(providerSessionId));
        assert.strictEqual(yield* Queue.size(fixture.closed), 0);
        // Recovering the kept process's own work is not a new turn and is never refused.
        yield* manager.open({
          threadId: threadA,
          providerSessionId,
          modelSelection: { instanceId, model: addedModel },
          runtimePolicy,
        });
        assert.strictEqual(yield* Ref.get(fixture.opens), 1);
      }).pipe(Effect.provide(layer(fixture)));
    }),
);

it.effect(
  "a model GOAT offers but a fresh process does not list is refused without restarting",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const { open } = yield* sharedSession;
        fixture.catalog.push(addedModel);
        fixture.freshProcessLacks.push(addedModel);
        yield* open(threadA);
        for (const threadId of [threadA, threadB]) {
          const refused = yield* open(threadId, addedModel).pipe(Effect.exit);
          assert.include(String(Exit.isFailure(refused) ? refused.cause : ""), "would not help");
        }
        assert.strictEqual(yield* Ref.get(fixture.opens), 1);
        assert.strictEqual(yield* Queue.size(fixture.closed), 0);
      }).pipe(Effect.provide(layer(fixture)));
    }),
);

it.effect("activity seen while the background check runs keeps a process a newer model needs", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { manager, open, runTurn, providerSessionId } = yield* sharedSession;
      yield* finishTurn(fixture, runTurn, threadA);
      fixture.catalog.push(addedModel);
      // The session's activity moves after the probe found nothing running and before removal.
      fixture.duringBackgroundProbe = manager.get(providerSessionId).pipe(Effect.ignore);
      const refused = yield* open(threadB, addedModel).pipe(Effect.exit);
      assert.include(String(Exit.isFailure(refused) ? refused.cause : ""), addedModel);
      assert.strictEqual(yield* Queue.size(fixture.closed), 0);
      assert.isTrue(yield* manager.isLive(providerSessionId));
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect(
  "a turn still starting on the process keeps it; only the newer model's turn is refused",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* Effect.gen(function* () {
        const { open, runTurn } = yield* sharedSession;
        // Thread A's turn-start open returned and it is loading its thread, not busy yet.
        yield* open(threadA);
        fixture.catalog.push(addedModel);
        const refused = yield* open(threadB, addedModel).pipe(Effect.exit);
        assert.include(String(Exit.isFailure(refused) ? refused.cause : ""), addedModel);
        assert.strictEqual(yield* Queue.size(fixture.closed), 0);

        yield* finishTurn(fixture, runTurn, threadA);
        assert.strictEqual(yield* Ref.get(fixture.opens), 1);
        yield* open(threadB, addedModel);
        assert.strictEqual(yield* Ref.get(fixture.opens), 2);
      }).pipe(Effect.provide(layer(fixture)));
    }),
);

it.effect("a start still running after minutes keeps holding the process", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { manager, open, providerSessionId } = yield* sharedSession;
      // Thread A's start is still waiting on a slow thread/start; only its own exit ends the hold.
      yield* open(threadA);
      fixture.catalog.push(addedModel);
      yield* TestClock.adjust("10 minutes");
      const refused = yield* open(threadB, addedModel).pipe(Effect.exit);
      assert.include(String(Exit.isFailure(refused) ? refused.cause : ""), addedModel);
      assert.strictEqual(yield* Queue.size(fixture.closed), 0);
      assert.isTrue(yield* manager.isLive(providerSessionId));
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect("a refused turn leaves no start behind; the next newer-model turn restarts at once", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { open, runTurn, endStart } = yield* sharedSession;
      const turn = yield* runTurn(threadA).pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(fixture.turnStarted);
      fixture.catalog.push(addedModel);
      assert.isTrue(Exit.isFailure(yield* open(threadB, addedModel).pipe(Effect.exit)));
      yield* endStart(threadB);

      yield* Deferred.succeed(fixture.endTurn, undefined);
      yield* Fiber.join(turn);
      yield* open(threadC, addedModel);
      assert.strictEqual(yield* Ref.get(fixture.opens), 2);
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect("a start that fails after its open stops holding the process at once", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { open, endStart } = yield* sharedSession;
      // Thread A's open returned, then its start failed (say, loading its thread) before registering.
      yield* open(threadA);
      yield* endStart(threadA);
      fixture.catalog.push(addedModel);
      yield* open(threadB, addedModel);
      assert.strictEqual(yield* Ref.get(fixture.opens), 2);
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect("an idle deadline that falls during the model check does not close the process", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { open, runTurn } = yield* sharedSession;
      yield* finishTurn(fixture, runTurn, threadA);
      yield* TestClock.adjust("29 minutes");
      const checking = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<void>();
      fixture.duringModelStatus = Deferred.succeed(checking, undefined).pipe(
        Effect.andThen(Deferred.await(answer)),
      );
      const opening = yield* open(threadB).pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(checking);
      // The idle deadline armed when thread A's turn ended passes while the process is asked.
      yield* TestClock.adjust("2 minutes");
      fixture.duringModelStatus = Effect.void;
      yield* Deferred.succeed(answer, undefined);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(opening)));
      assert.strictEqual(yield* Queue.size(fixture.closed), 0);
      assert.strictEqual(yield* Ref.get(fixture.opens), 1);
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect("a process that cannot list its models still runs the turn and is never restarted", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { open, runTurn } = yield* sharedSession;
      yield* finishTurn(fixture, runTurn, threadA);
      fixture.listingUnavailable = true;
      fixture.catalog.push(addedModel);
      yield* open(threadB, addedModel);
      assert.strictEqual(yield* Ref.get(fixture.opens), 1);
      assert.strictEqual(yield* Queue.size(fixture.closed), 0);
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

/** Thread B's start opens while the idle timer armed when thread A's turn ended comes due. */
const idleReleaseDuringStart = (startsTurn: boolean) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { open, runTurn } = yield* sharedSession;
      yield* finishTurn(fixture, runTurn, threadA);
      yield* TestClock.adjust("29 minutes");
      const rearming = yield* Deferred.make<void>();
      const rearm = yield* Deferred.make<void>();
      // B's open is about to re-arm the idle timer; the old timer has not been stopped yet.
      fixture.beforeIdleInterrupt = Effect.suspend(() => {
        fixture.beforeIdleInterrupt = Effect.void;
        return Deferred.succeed(rearming, undefined).pipe(Effect.andThen(Deferred.await(rearm)));
      });
      const opening = yield* open(threadB, modelSelection.model, startsTurn).pipe(
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(rearming);
      yield* TestClock.adjust("2 minutes");
      yield* Deferred.succeed(rearm, undefined);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(opening)));
      assert.strictEqual(yield* Queue.size(fixture.closed), 0);
      assert.strictEqual(yield* Ref.get(fixture.opens), 1);
    }).pipe(Effect.provide(layer(fixture)));
  });

it.effect(
  "an idle release already under way when a turn reserves the process leaves it running",
  () => idleReleaseDuringStart(true),
);

it.effect(
  "a start exempt from the model check still reserves its process against idle release",
  () =>
    // A goal pause or a survivor adoption opens without the model check.
    idleReleaseDuringStart(false),
);

it.effect("a turn on a process that does not answer its model list waits for one listing", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const listings = yield* Ref.make(0);
    const asked = yield* Deferred.make<void>();
    fixture.listServed = Effect.sync(() => fixture.catalog);
    yield* Effect.gen(function* () {
      const { open, runTurn } = yield* sharedSession;
      yield* finishTurn(fixture, runTurn, threadA);
      fixture.catalog.push(addedModel);
      fixture.listServed = Ref.update(listings, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(asked, undefined)),
        Effect.andThen(Effect.never),
      );
      const opening = yield* open(threadB, addedModel).pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(asked);
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(yield* Ref.get(listings), 1);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(opening)));
      assert.strictEqual(yield* Ref.get(fixture.opens), 1);
    }).pipe(Effect.provide(layer(fixture)));
  }),
);

it.effect("starts queued behind a slow listing on a busy process share its answer", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const listings = yield* Ref.make(0);
    const listing = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<void>();
    fixture.listServed = Effect.sync(() => fixture.catalog);
    yield* Effect.gen(function* () {
      const { open, runTurn } = yield* sharedSession;
      // Thread A's turn keeps the shared process busy, so a newer model's turn is refused.
      yield* runTurn(threadA).pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(fixture.turnStarted);
      fixture.catalog.push(addedModel);
      fixture.listServed = Ref.update(listings, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(listing, undefined)),
        Effect.andThen(Deferred.await(answer)),
        Effect.as([modelSelection.model]),
      );
      const first = yield* open(threadB, addedModel).pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(listing);
      // Thread C's start waits for the session while B's listing is slow to answer.
      const queued = yield* open(threadC, addedModel).pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("8 seconds");
      yield* Deferred.succeed(answer, undefined);
      for (const refused of [yield* Fiber.join(first), yield* Fiber.join(queued)])
        assert.include(String(Exit.isFailure(refused) ? refused.cause : ""), addedModel);
      assert.strictEqual(yield* Ref.get(listings), 1);
    }).pipe(Effect.provide(layer(fixture)));
  }),
);
