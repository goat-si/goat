import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProviderDriverKind,
  ProviderInstanceId,
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
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;

type Hold = "held" | "free" | "fail";

interface Fixture {
  readonly opens: Ref.Ref<number>;
  readonly closing: Queue.Queue<void>;
  readonly closed: Queue.Queue<void>;
  /** How the next opened session's scope close behaves. */
  readonly nextClose: Ref.Ref<Effect.Effect<void>>;
  readonly hold?: Ref.Ref<Hold>;
  readonly holdProbes: Ref.Ref<ReadonlyArray<boolean>>;
  readonly pendingBackgroundWork?: boolean;
  readonly reopenAfterClose?: boolean;
}

const makeFixture = (options: {
  readonly hold?: Hold;
  readonly pendingBackgroundWork?: boolean;
  readonly reopenAfterClose?: boolean;
}) =>
  Effect.gen(function* () {
    const fixture: Fixture = {
      opens: yield* Ref.make(0),
      closing: yield* Queue.unbounded<void>(),
      closed: yield* Queue.unbounded<void>(),
      nextClose: yield* Ref.make<Effect.Effect<void>>(Effect.void),
      holdProbes: yield* Ref.make<ReadonlyArray<boolean>>([]),
      ...(options.hold === undefined ? {} : { hold: yield* Ref.make(options.hold) }),
      ...(options.pendingBackgroundWork === undefined
        ? {}
        : { pendingBackgroundWork: options.pendingBackgroundWork }),
      ...(options.reopenAfterClose === undefined
        ? {}
        : { reopenAfterClose: options.reopenAfterClose }),
    };
    return fixture;
  });

const unused = (detail: string) =>
  Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));

const makeAdapter = (fixture: Fixture) =>
  ProviderAdapter.ProviderAdapterV2.of({
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(fixture.opens, (count) => count + 1);
        const close = yield* Ref.getAndSet(fixture.nextClose, Effect.void);
        yield* Effect.addFinalizer(() =>
          Queue.offer(fixture.closing, undefined).pipe(
            Effect.andThen(close),
            Effect.ensuring(Queue.offer(fixture.closed, undefined)),
          ),
        );
        const now = yield* DateTime.now;
        const hold = fixture.hold;
        return {
          instanceId: modelSelection.instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: modelSelection.instanceId,
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
          ...(fixture.pendingBackgroundWork === undefined
            ? {}
            : { hasPendingBackgroundWork: Effect.succeed(fixture.pendingBackgroundWork) }),
          ...(hold === undefined
            ? {}
            : {
                holdsLiveWork: ({ pastPinCeiling }) =>
                  Ref.update(fixture.holdProbes, (probes) => [...probes, pastPinCeiling]).pipe(
                    Effect.andThen(Ref.get(hold)),
                    Effect.flatMap((state) =>
                      state === "fail"
                        ? Effect.die("probe failed")
                        : Effect.succeed(state === "held"),
                    ),
                  ),
              }),
          ...(fixture.reopenAfterClose === true ? { reopenAfterClose: true as const } : {}),
          ensureThread: () => unused("ensureThread"),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: () => Effect.void,
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
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
  ),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("session-lifecycle-test")),
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const ingestor = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        // @effect-diagnostics-next-line effectSucceedWithVoid:off - Optional instances require undefined rather than void.
        getInstance: () => Effect.succeed(undefined),
      }),
      layerTestEventSink,
      IdAllocator.layer,
      layerTestStores,
      ThreadCommandExecutor.layer,
      Layer.mock(GitVcsDriver.GitVcsDriver)({ resolveBranchName: () => Effect.succeed(null) }),
    ),
  ),
);

const layer = (fixture: Fixture, options: { readonly maxIdlePinMs?: number } = {}) =>
  Layer.mergeAll(
    layerTestEventSink,
    IdAllocator.layer,
    ProviderSessionManager.layerWithOptions({ idleTimeoutMs: 1_000, ...options }).pipe(
      Layer.provide(
        Layer.mergeAll(
          ProviderAdapterRegistry.layerSingle(makeAdapter(fixture)).pipe(
            Layer.provideMerge(McpProviderSessions.layer),
          ),
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

const openSession = Effect.gen(function* () {
  const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("thread-session-lifecycle");
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: yield* idAllocator.allocate.project({ fixtureName: "session-lifecycle" }),
    title: "Session lifecycle",
    providerInstanceId: modelSelection.instanceId,
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
  };
  yield* eventSink.write({
    events: [
      {
        id: yield* idAllocator.allocate.event({ threadId }),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
  const providerSessionId = idAllocator.derive.providerSession({
    providerInstanceId: modelSelection.instanceId,
    threadId,
  });
  const reopen = manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
  yield* reopen;
  return { manager, providerSessionId, reopen };
});

it.effect("live work keeps an idle session past the pin ceiling until it settles", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({ hold: "held" });
    yield* Effect.gen(function* () {
      const { manager, providerSessionId } = yield* openSession;
      yield* TestClock.adjust("20 seconds");
      assert.isTrue(yield* manager.isLive(providerSessionId));
      // Past the ceiling the runtime is asked to confirm, and a probe that fails still holds.
      assert.include(yield* Ref.get(fixture.holdProbes), true);
      yield* Ref.set(fixture.hold!, "fail");
      yield* TestClock.adjust("2 seconds");
      assert.isTrue(yield* manager.isLive(providerSessionId));
      assert.strictEqual(yield* Queue.size(fixture.closed), 0);

      yield* Ref.set(fixture.hold!, "free");
      yield* TestClock.adjust("1 second");
      yield* Queue.take(fixture.closed);
      assert.isFalse(yield* manager.isLive(providerSessionId));
    }).pipe(Effect.provide(layer(fixture, { maxIdlePinMs: 4_000 })));
  }),
);

it.effect("pending background work without live work still ends at the pin ceiling", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({ hold: "free", pendingBackgroundWork: true });
    yield* Effect.gen(function* () {
      const { manager, providerSessionId } = yield* openSession;
      yield* TestClock.adjust("3 seconds");
      assert.isTrue(yield* manager.isLive(providerSessionId));
      yield* TestClock.adjust("2 seconds");
      yield* Queue.take(fixture.closed);
      assert.isFalse(yield* manager.isLive(providerSessionId));
    }).pipe(Effect.provide(layer(fixture, { maxIdlePinMs: 4_000 })));
  }),
);

/** Releases the open session, its close held at `gate`, and returns once the close has begun. */
const releaseHeld = (fixture: Fixture, gate: Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* Ref.set(fixture.nextClose, gate);
    const opened = yield* openSession;
    const release = yield* opened.manager
      .close(opened.providerSessionId)
      .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
    yield* Queue.take(fixture.closing);
    return { ...opened, release };
  });

it.effect("a reopen waits for an opted-in session's close and then opens a fresh process", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({ reopenAfterClose: true });
    const exited = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { manager, providerSessionId, reopen, release } = yield* releaseHeld(
        fixture,
        Deferred.await(exited),
      );
      const reopened = yield* reopen.pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(yield* Ref.get(fixture.opens), 1);
      assert.isFalse(yield* manager.isLive(providerSessionId));

      yield* Deferred.succeed(exited, undefined);
      yield* Fiber.join(reopened);
      assert.strictEqual(yield* Ref.get(fixture.opens), 2);
      assert.isTrue(yield* manager.isLive(providerSessionId));
      yield* Fiber.join(release);
    }).pipe(Effect.ensuring(Deferred.succeed(exited, undefined)), Effect.provide(layer(fixture)));
  }),
);

it.effect("a reopen fails after the bound while the old close never finishes", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({ reopenAfterClose: true });
    const exited = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { reopen } = yield* releaseHeld(fixture, Deferred.await(exited));
      const reopened = yield* reopen.pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("30 seconds");
      const exit = yield* Fiber.join(reopened);
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "still stopping");
      assert.strictEqual(yield* Ref.get(fixture.opens), 1);
    }).pipe(Effect.ensuring(Deferred.succeed(exited, undefined)), Effect.provide(layer(fixture)));
  }),
);

it.effect("a failed termination ends the hold, so the reopen reaches the adapter again", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({ reopenAfterClose: true });
    const fail = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { reopen } = yield* releaseHeld(
        fixture,
        Deferred.await(fail).pipe(Effect.andThen(Effect.die("termination failed"))),
      );
      const reopened = yield* reopen.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(fail, undefined);
      yield* Fiber.join(reopened);
      assert.strictEqual(yield* Ref.get(fixture.opens), 2);
    }).pipe(Effect.ensuring(Deferred.succeed(fail, undefined)), Effect.provide(layer(fixture)));
  }),
);

it.effect("a provider that does not opt in reopens while its old close is still running", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({});
    const exited = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const { reopen } = yield* releaseHeld(fixture, Deferred.await(exited));
      yield* reopen;
      assert.strictEqual(yield* Ref.get(fixture.opens), 2);
    }).pipe(Effect.ensuring(Deferred.succeed(exited, undefined)), Effect.provide(layer(fixture)));
  }),
);
