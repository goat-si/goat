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
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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
        modelStatus: (model) =>
          Effect.succeed(
            !fixture.catalog.includes(model) || known.has(model)
              ? "ready"
              : offeredAtStart.has(model)
                ? "missing"
                : "predated",
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
    ProviderSessionManager.layer.pipe(
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
  const providerSessionId: ProviderSessionId = idAllocator.derive.providerSession({
    providerInstanceId: instanceId,
  });
  const open = (threadId: ThreadId, model = modelSelection.model) =>
    manager.open({
      threadId,
      providerSessionId,
      modelSelection: { instanceId, model },
      runtimePolicy,
      startsTurn: true,
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
  return { manager, providerSessionId, open, runTurn };
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

it.effect("a turn on a model added after Codex started opens a fresh process when it is idle", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { manager, open, providerSessionId } = yield* sharedSession;
      yield* open(threadA);
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
      const { open } = yield* sharedSession;
      yield* open(threadA);
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
      const { manager, open, providerSessionId } = yield* sharedSession;
      yield* open(threadA);
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
