import { assert, it } from "@effect/vitest";
import { EventId, NodeId, ProviderSessionId, ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  interruptResult,
  parentWithTask,
  refusal,
  runCauses,
  runStatuses,
  stopRequested,
  updateChildProviderThread,
  updateTask,
} from "./delegatedForceStop.testkit.ts";
import {
  adapter,
  createWatchingThread,
  delegate,
  layerForAdapter,
  layerTest,
  send,
} from "./ThreadStop.testkit.ts";

it.effect("the parent's Force stop ends its task's child after Stop went unanswered", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parentThreadId, childThreadId, taskId } = yield* parentWithTask(
      "force-ok",
      "unanswered",
    );
    const forced = yield* threads.forceStopDelegatedTask({ parentThreadId, taskId });
    assert.equal(forced.childThreadId, childThreadId);
    assert.deepEqual(yield* runStatuses(childThreadId), ["interrupted"]);
    // Status says an agent stopped it, unlike a person's Force stop.
    assert.deepEqual(yield* runCauses(childThreadId), ["agent_stop"]);
    const result = (yield* orchestrator.getThreadProjection(childThreadId)).turnItems.find(
      (item) => item.type === "run_interrupt_result",
    );
    // The child's timeline names who force stopped it by title, never by raw id.
    assert.equal(
      result?.type === "run_interrupt_result" ? result.message : undefined,
      'Force stopped by parent thread "force-ok parent"',
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a first Force stop, before any Stop timed out, refuses and stops nothing", () =>
  Effect.gen(function* () {
    const { parentThreadId, childThreadId, taskId } = yield* parentWithTask(
      "force-early",
      "requested",
    );
    assert.equal(yield* refusal({ parentThreadId, taskId }), "not_unresponsive");
    assert.deepEqual(yield* runStatuses(childThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("only the thread that created the task can force stop it", () =>
  Effect.gen(function* () {
    const { childThreadId, taskId } = yield* parentWithTask("force-owner", "unanswered");
    // Another parent's task, and a top-level thread that no task of this thread names.
    const other = yield* parentWithTask("force-other", "unanswered");
    assert.equal(yield* refusal({ parentThreadId: other.parentThreadId, taskId }), "not_owner");
    assert.equal(
      yield* refusal({
        parentThreadId: other.parentThreadId,
        taskId: NodeId.make(String(childThreadId)),
      }),
      "not_owner",
    );
    assert.deepEqual(yield* runStatuses(childThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a grandchild is not its grandparent's to force stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parentThreadId, childThreadId } = yield* parentWithTask("force-grand", "none");
    const grandchildThreadId = yield* delegate(childThreadId, "force-grand nested");
    yield* stopRequested(grandchildThreadId, true);
    const grandTaskId = (yield* orchestrator.getThreadProjection(childThreadId)).subagents.find(
      (task) => task.childThreadId === grandchildThreadId,
    )!.id;
    assert.equal(yield* refusal({ parentThreadId, taskId: grandTaskId }), "not_owner");
    assert.deepEqual(yield* runStatuses(grandchildThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "a child the person promoted to a top-level thread", promoted: true },
  { name: "a provider-native subagent", promoted: false },
])("$name is not its parent's to force stop, even after Stop went unanswered", (row) =>
  Effect.gen(function* () {
    const task = yield* parentWithTask(`force-unowned-${row.promoted}`, "unanswered");
    yield* updateTask(task.parentThreadId, task.taskId, (record, now) =>
      row.promoted ? { ...record, promotedAt: now } : { ...record, origin: "provider_native" },
    );
    assert.equal(yield* refusal(task), "not_owner");
    assert.deepEqual(yield* runStatuses(task.childThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "the force decision reads only durable state, so a new server instance decides it the same",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = Layer.succeedContext(yield* Layer.build(SqlitePersistence.layerMemory));
        // Each provide builds new services over the same storage, as a restarted server does.
        const server = layerForAdapter(adapter, { database });
        const task = yield* parentWithTask("force-restart", "unanswered").pipe(
          Effect.provide(server),
        );
        const forced = yield* ThreadManagementService.ThreadManagementService.use((threads) =>
          threads.forceStopDelegatedTask(task),
        ).pipe(Effect.provide(server));
        assert.equal(forced.childThreadId, task.childThreadId);
        const after = yield* Effect.all({
          runs: runStatuses(task.childThreadId),
          reason: interruptResult(task.childThreadId),
          again: refusal(task),
        }).pipe(Effect.provide(server));
        assert.deepEqual(after, {
          runs: ["interrupted"],
          reason: 'Force stopped by parent thread "force-restart parent"',
          again: "not_unresponsive",
        });
      }),
    ),
);

it.effect("after a restart cancelled the run, the parent's force stops nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = Layer.succeedContext(yield* Layer.build(SqlitePersistence.layerMemory));
      const task = yield* parentWithTask("force-recovered", "unanswered").pipe(
        Effect.provide(layerForAdapter(adapter, { database })),
      );
      // Startup recovery cancels every run the previous server left running.
      yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.use(
        (recovery) => recovery.recover,
      ).pipe(
        Effect.provide(
          ProviderRuntimeRecovery.layer.pipe(
            Layer.provideMerge(
              EventSink.layer.pipe(
                Layer.provideMerge(
                  Layer.mergeAll(
                    EventStore.layer,
                    ProjectionStore.layer,
                    EffectOutbox.layer,
                    IdAllocator.layer,
                  ),
                ),
              ),
            ),
            Layer.provide(Layer.mergeAll(database, ServerSettings.layerTest())),
          ),
        ),
      );
      const calls: Array<string> = [];
      const sessions = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        isLive: () => Effect.succeed(true),
        otherWorkingThreads: () => Effect.succeed([]),
        detach: () => Effect.sync(() => calls.push("detach")),
        releaseUnlessBusy: () => Effect.sync(() => calls.push("release")).pipe(Effect.as(true)),
      });
      const after = yield* Effect.all({
        refusal: refusal(task),
        runs: runStatuses(task.childThreadId),
        causes: runCauses(task.childThreadId),
        reason: interruptResult(task.childThreadId),
      }).pipe(Effect.provide(layerForAdapter(adapter, { database, sessions })));
      assert.deepEqual(
        { ...after, calls },
        {
          refusal: "not_unresponsive",
          runs: ["cancelled"],
          causes: ["server_restart"],
          reason: undefined,
          calls: [],
        },
      );
    }),
  ),
);

it.effect("the parent's Force stop of a cloud child refuses and leaves its run alone", () =>
  Effect.gen(function* () {
    const task = yield* parentWithTask("force-cloud", "unanswered");
    yield* updateChildProviderThread(task.childThreadId, (thread, now) => ({
      ...thread,
      cloudTask: {
        taskId: "cloud-task-1",
        status: "running",
        tracking: "polled",
        source: { repository: "goat-si/goat", branch: "dev" },
        localChangesExcluded: false,
        updatedAt: DateTime.formatIso(now),
      },
    }));
    assert.equal(yield* refusal(task), "cloud");
    assert.deepEqual(yield* runStatuses(task.childThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "the provider confirms the Stop", meanwhile: "ended", runs: ["interrupted"] },
  { name: "a person asks to Stop again", meanwhile: "stopAgain", runs: ["running"] },
] as const)("$name while force waits for the lock: the child is left alone", (row) => {
  const calls: Array<string> = [];
  const sessions = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
    isLive: () => Effect.succeed(true),
    otherWorkingThreads: () => Effect.succeed([]),
    detach: () => Effect.sync(() => calls.push("detach")),
    releaseUnlessBusy: () => Effect.sync(() => calls.push("release")).pipe(Effect.as(true)),
  });
  // Pauses force after its first check, before it takes the thread lock.
  let gate:
    | { readonly checked: Deferred.Deferred<void>; readonly proceed: Deferred.Deferred<void> }
    | undefined;
  let reads = 0;
  const orchestrator = (service: Orchestrator.OrchestratorV2["Service"]) =>
    ({
      ...service,
      getThreadRecords: (threadId, keys, options) =>
        service
          .getThreadRecords(threadId, keys, options)
          .pipe(
            Effect.tap(() =>
              gate !== undefined &&
              (keys as ReadonlyArray<string>).includes("turnItems") &&
              reads++ === 0
                ? Deferred.succeed(gate.checked, undefined).pipe(
                    Effect.andThen(Deferred.await(gate.proceed)),
                  )
                : Effect.void,
            ),
          ),
    }) satisfies Orchestrator.OrchestratorV2["Service"];
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const task = yield* parentWithTask(`force-race-${row.meanwhile}`, "unanswered");
    gate = { checked: yield* Deferred.make<void>(), proceed: yield* Deferred.make<void>() };
    const forcing = yield* threads.forceStopDelegatedTask(task).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(gate.checked);
    const child = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
      task.childThreadId,
    );
    const run = child.runs[0]!;
    const now = yield* DateTime.now;
    if (row.meanwhile === "ended") {
      // The provider confirms the Stop, so the run ends before force takes the lock.
      yield* projections.apply({
        id: EventId.make("event:force-race:run-ended"),
        type: "run.updated",
        threadId: task.childThreadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "interrupted", completedAt: now },
      });
    } else {
      // A newer Stop waits for its own answer, so the run is active but no longer unresponsive.
      const request = child.turnItems.find((item) => item.type === "run_interrupt_request")!;
      const { unresponsiveAt: _unanswered, ...fresh } = request as typeof request & {
        readonly unresponsiveAt?: unknown;
      };
      yield* projections.apply({
        id: EventId.make("event:force-race:stop-again"),
        type: "turn-item.updated",
        threadId: task.childThreadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          ...fresh,
          id: TurnItemId.make("turn-item:force-race:stop-again"),
          ordinal: request.ordinal + 1,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        } as typeof request,
      });
    }
    yield* Deferred.succeed(gate.proceed, undefined);
    const error = yield* Fiber.join(forcing);
    assert.equal(
      error._tag === "DelegatedForceStopRefused" ? error.reason : error._tag,
      "not_unresponsive",
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(yield* runStatuses(task.childThreadId), [...row.runs]);
    assert.equal(yield* interruptResult(task.childThreadId), undefined);
  }).pipe(Effect.provide(layerForAdapter(adapter, { sessions, orchestrator })));
});

it.effect("the parent's Force stop detaches a child session another working thread shares", () => {
  const calls: Array<string> = [];
  const sibling = ThreadId.make("thread:force-shared-sibling");
  const sessions = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
    isLive: () => Effect.succeed(true),
    otherWorkingThreads: () => Effect.succeed([sibling]),
    detach: () => Effect.sync(() => calls.push("detach")),
    releaseUnlessBusy: () => Effect.sync(() => calls.push("release")).pipe(Effect.as(true)),
  });
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* createWatchingThread(sibling, 41);
    yield* send(sibling, "sibling work", "start_immediately");
    const siblingRuns = yield* runStatuses(sibling);
    const task = yield* parentWithTask("force-shared", "unanswered");
    yield* updateChildProviderThread(task.childThreadId, (thread) => ({
      ...thread,
      providerSessionId: ProviderSessionId.make("provider-session:force-shared"),
    }));
    const forced = yield* threads.forceStopDelegatedTask(task);
    assert.deepEqual(
      { outcome: forced.outcome, sharedWith: forced.sharedWithThreadIds, calls },
      { outcome: "shared", sharedWith: [sibling], calls: ["detach"] },
    );
    assert.deepEqual(yield* runStatuses(task.childThreadId), ["interrupted"]);
    assert.deepEqual(yield* runStatuses(sibling), siblingRuns);
  }).pipe(Effect.provide(layerForAdapter(adapter, { sessions })));
});
