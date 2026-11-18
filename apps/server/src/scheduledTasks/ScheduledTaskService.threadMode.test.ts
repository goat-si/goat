import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTaskThreadMode,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { layerSink, syntheticLaunch } from "./ScheduledRunFixture.testkit.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const input = {
  id: ScheduledTaskId.make("task:thread-mode"),
  title: "Triage",
  prompt: "Triage new issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project:test"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

interface Gate {
  readonly launching: Deferred.Deferred<void>;
  readonly proceed: Deferred.Deferred<void>;
  readonly afterCommit?: boolean;
}

/**
 * Launches write their thread, message and run like the real launch, so a firing resolves; a gate
 * holds a launch mid-flight. Sends record their thread and fresh flag.
 */
const harness = (options: { readonly threadDeleted?: boolean } = {}) =>
  Effect.gen(function* () {
    const launched = yield* Ref.make<ReadonlyArray<ThreadId | null>>([]);
    const sends = yield* Ref.make<Array<{ threadId: ThreadId; freshContext: boolean }>>([]);
    const gate = yield* Ref.make<Gate | null>(null);
    const launchLayer = Layer.unwrap(
      Effect.gen(function* () {
        const launch = syntheticLaunch(yield* EventSink.EventSinkV2);
        return Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (request) =>
            Effect.gen(function* () {
              const held = yield* Ref.get(gate);
              if (held !== null && !held.afterCommit) {
                yield* Deferred.succeed(held.launching, undefined);
                yield* Deferred.await(held.proceed);
              }
              const result = yield* launch(request);
              yield* Ref.update(launched, (all) => [...all, result.threadId]);
              if (held?.afterCommit) {
                yield* Deferred.succeed(held.launching, undefined);
                yield* Deferred.await(held.proceed);
              }
              return result;
            }).pipe(Effect.orDie),
        });
      }),
    ).pipe(Layer.provide(layerSink));
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          launchLayer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                deletedAt:
                  options.threadDeleted === true
                    ? DateTime.makeUnsafe("2026-11-03T00:00:00Z")
                    : null,
              } as never),
            sendToThread: (send) =>
              Ref.update(sends, (all) => [
                ...all,
                { threadId: send.threadId, freshContext: send.freshContext === true },
              ]).pipe(Effect.as({ run: { id: "run:sent", threadId: send.threadId } } as never)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    return { launched, sends, gate, layer };
  });

const storedMode = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ thread_id: string | null; thread_mode: string }>`
    SELECT thread_id, thread_mode FROM scheduled_tasks WHERE task_id = ${input.id}`;
  return rows[0];
});

const holdLaunches = (gate: Ref.Ref<Gate | null>, afterCommit = false) =>
  Effect.gen(function* () {
    const held = {
      launching: yield* Deferred.make<void>(),
      proceed: yield* Deferred.make<void>(),
      afterCommit,
    };
    yield* Ref.set(gate, held);
    return held;
  });

it.effect.each(["continue", "fresh_session"] as const)(
  "a %s task keeps its first accepted thread across a restart before launch returns",
  (mode) =>
    Effect.gen(function* () {
      const { gate, launched, sends, layer } = yield* harness();
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* service.upsert({ ...input, threadMode: mode });
        const held = yield* holdLaunches(gate, true);
        const run = yield* Effect.forkChild(service.runNow({ id: input.id }));
        yield* Deferred.await(held.launching);
        const [first] = yield* Ref.get(launched);
        if (first == null) return yield* Effect.die("The first run did not launch a thread.");
        assert.equal((yield* service.list()).tasks[0]?.threadId, first);
        assert.deepEqual(yield* sql`SELECT dispatch_bookkept_at FROM scheduled_task_runs`, [
          { dispatch_bookkept_at: null },
        ]);
        yield* Ref.set(gate, null);
        yield* TestClock.adjust("1 second");
        yield* Effect.gen(function* () {
          const restarted = yield* ScheduledTaskService.ScheduledTaskService;
          assert.equal((yield* restarted.list()).tasks[0]?.threadId, first);
          yield* restarted.runNow({ id: input.id });
          assert.deepEqual(yield* Ref.get(launched), [first]);
          assert.deepEqual(yield* Ref.get(sends), [
            { threadId: first, freshContext: mode === "fresh_session" },
          ]);
        }).pipe(Effect.provide(Layer.fresh(layer)));
        yield* Fiber.interrupt(run);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["archived_at", "deleted_at"] as const)(
  "a first accepted run never binds a thread already marked %s",
  (column) =>
    Effect.gen(function* () {
      const { launched, layer } = yield* harness();
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* service.upsert({ ...input, threadMode: "continue" });
        yield* sql`CREATE TRIGGER retire_thread_before_acceptance
          AFTER INSERT ON orchestration_v2_projection_runs BEGIN
            UPDATE orchestration_v2_projection_threads SET ${sql(column)} = '2026-11-18T00:00:00Z'
            WHERE thread_id = NEW.thread_id;
          END`;
        const first = yield* service.runNow({ id: input.id });
        assert.equal(first.task.lastRun?.dispatchStatus, "accepted");
        assert.isNull(first.task.threadId);
        yield* sql`DROP TRIGGER retire_thread_before_acceptance`;
        yield* TestClock.adjust("1 second");
        const next = yield* service.runNow({ id: input.id });
        assert.deepEqual(yield* Ref.get(launched), [first.threadId, next.threadId]);
        assert.notEqual(next.threadId, first.threadId);
        assert.equal(next.task.threadId, next.threadId);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("switching to one thread never recovers a previous new-thread firing", () =>
  Effect.gen(function* () {
    const { launched, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert({ ...input, threadMode: "new_thread" });
      yield* service.runNow({ id: input.id });
      yield* TestClock.adjust("1 second");
      yield* service.runNow({ id: input.id });
      yield* service.upsert({ ...input, threadMode: "continue" });
    }).pipe(Effect.provide(layer));
    yield* TestClock.adjust("1 second");
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      assert.isNull((yield* service.list()).tasks[0]?.threadId);
      const next = yield* service.runNow({ id: input.id });
      assert.lengthOf(new Set(yield* Ref.get(launched)), 3);
      assert.equal(next.task.threadId, next.threadId);
    }).pipe(Effect.provide(Layer.fresh(layer)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a failed first bind rolls back the initial scheduled message and run", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert({ ...input, threadMode: "continue" });
      yield* sql`CREATE TRIGGER refuse_first_bind BEFORE UPDATE OF thread_id ON scheduled_tasks
        WHEN NEW.thread_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected bind failure'); END`;
      yield* Effect.exit(service.runNow({ id: input.id }));
      const [task] = (yield* service.list()).tasks;
      assert.isNull(task?.threadId);
      assert.notEqual(task?.lastRun?.dispatchStatus, "accepted");
      assert.deepEqual(yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`, []);
      assert.deepEqual(yield* sql`SELECT message_id FROM orchestration_v2_projection_messages`, []);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["mode", "project"] as const)(
  "an in-flight first launch stays unbound when the %s changes away and back",
  (destination) =>
    Effect.gen(function* () {
      const { gate, launched, layer } = yield* harness();
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const task = { ...input, threadMode: "continue" } as const;
        yield* service.upsert(task);
        const held = yield* holdLaunches(gate);
        const first = yield* Effect.forkChild(service.runNow({ id: input.id }));
        yield* Deferred.await(held.launching);
        yield* service.upsert(
          destination === "mode"
            ? { ...task, threadMode: "new_thread" }
            : { ...task, projectId: ProjectId.make("project:moved") },
        );
        yield* service.upsert(task);
        yield* Ref.set(gate, null);
        yield* Deferred.succeed(held.proceed, undefined);
        yield* Fiber.join(first);
        assert.isNull((yield* service.list()).tasks[0]?.threadId);
        yield* TestClock.adjust("1 second");
        const next = yield* service.runNow({ id: input.id });
        assert.lengthOf(new Set(yield* Ref.get(launched)), 2);
        assert.equal(next.task.threadId, next.threadId);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

// Carried from upstream 4aab23cd72 (ScheduledTaskService.test.ts), on GOAT's durable launch.
it.effect("a fresh-session task launches one thread, then starts each later run fresh in it", () =>
  Effect.gen(function* () {
    const { launched, sends, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert({ ...input, threadMode: "fresh_session" });

      const first = (yield* service.runNow({ id: input.id })).threadId;
      assert.deepEqual(yield* Ref.get(launched), [first]);
      // A form opened before the first run saves no thread; the binding stays.
      const { task } = yield* service.upsert({
        ...input,
        threadId: null,
        threadMode: "fresh_session",
      });
      assert.equal(task.threadId, first);
      assert.equal(task.threadMode, "fresh_session");
      // A client that predates thread modes sends neither; both stay.
      const legacy = yield* service.upsert({ ...input, threadId: null });
      assert.equal(legacy.task.threadId, first);
      assert.equal(legacy.task.threadMode, "fresh_session");
      // Manual runs in the same millisecond share a firing; a later one is a new run.
      yield* TestClock.adjust("1 second");
      yield* service.runNow({ id: input.id });

      assert.lengthOf(yield* Ref.get(launched), 1);
      assert.deepEqual(yield* Ref.get(sends), [{ threadId: first, freshContext: true }]);
      // Its thread stays in the old project, so moving the task leaves it for a new one.
      const moved = yield* service.upsert({
        ...input,
        projectId: ProjectId.make("project:moved"),
        threadId: first,
      });
      assert.equal(moved.task.threadId, null);
      assert.equal(moved.task.threadMode, "fresh_session");
      const unbound = yield* service.upsert({ ...input, threadMode: "new_thread" });
      assert.equal(unbound.task.threadId, null);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("removes a task when its first thread is observed deleted after acceptance", () =>
  Effect.gen(function* () {
    // The shell lookup after acceptance observes the thread as deleted.
    const { layer } = yield* harness({ threadDeleted: true });
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({ ...input, threadMode: "continue" });
      // Removing the task removes its firing too, so this run fails as any run of a deleted task.
      yield* Effect.exit(service.runNow({ id: task.id }));
      assert.deepEqual((yield* service.list()).tasks, []);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["recreated under the same id", "moved to another project"] as const)(
  "a first run never binds its thread to a task %s",
  (change) =>
    Effect.gen(function* () {
      const { gate, layer } = yield* harness();
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const fresh = { ...input, threadMode: "fresh_session" } as const;
        yield* service.upsert(fresh);
        const held = yield* holdLaunches(gate);
        const run = yield* Effect.forkChild(service.runNow({ id: input.id }));
        yield* Deferred.await(held.launching);
        if (change === "recreated under the same id") {
          yield* service.delete({ id: input.id });
          yield* TestClock.adjust("1 second");
          yield* service.upsert(fresh);
        } else {
          yield* service.upsert({ ...fresh, projectId: ProjectId.make("project:moved") });
        }
        yield* Deferred.succeed(held.proceed, undefined);
        yield* Fiber.await(run);

        const replacement = (yield* service.list()).tasks.find((task) => task.id === input.id);
        assert.equal(replacement?.threadId, null);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["continue", "fresh_session"] as const)(
  "an unbound %s task binds the thread its first run launches once, and an overlapping first run is refused",
  (mode) =>
    Effect.gen(function* () {
      const { launched, sends, gate, layer } = yield* harness();
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const saved = yield* service.upsert({ ...input, threadMode: mode });
        assert.equal(saved.task.threadId, null);
        assert.equal(saved.task.threadMode, mode);

        const held = yield* holdLaunches(gate);
        const first = yield* Effect.forkChild(service.runNow({ id: input.id }));
        yield* Deferred.await(held.launching);
        const overlapping = yield* Effect.flip(service.runNow({ id: input.id }));
        assert.include(overlapping.message, "already running");
        yield* Ref.set(gate, null);
        yield* Deferred.succeed(held.proceed, undefined);
        const thread = (yield* Fiber.join(first)).threadId;
        assert.deepEqual(yield* storedMode, { thread_id: thread, thread_mode: mode });

        yield* TestClock.adjust("1 second");
        yield* service.runNow({ id: input.id });
        assert.deepEqual(yield* Ref.get(launched), [thread]);
        assert.deepEqual(yield* Ref.get(sends), [
          { threadId: thread, freshContext: mode === "fresh_session" },
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a new-thread task launches a new thread every run and never binds one", () =>
  Effect.gen(function* () {
    const { launched, sends, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert({ ...input, threadMode: "new_thread" });
      yield* service.runNow({ id: input.id });
      yield* TestClock.adjust("1 second");
      yield* service.runNow({ id: input.id });
      assert.lengthOf(new Set(yield* Ref.get(launched)), 2);
      assert.deepEqual(yield* Ref.get(sends), []);
      assert.deepEqual(yield* storedMode, { thread_id: null, thread_mode: "new_thread" });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a save without a thread mode stores continue exactly when it names a thread", () =>
  Effect.gen(function* () {
    const { sends, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const bound = ThreadId.make("thread:named");
      yield* service.upsert(input);
      assert.deepEqual(yield* storedMode, { thread_id: null, thread_mode: "new_thread" });
      const rebound = yield* service.upsert({ ...input, threadId: bound });
      assert.equal(rebound.task.threadMode, "continue");
      assert.deepEqual(yield* storedMode, { thread_id: bound, thread_mode: "continue" });
      // A form loaded before the task was bound sends no thread; the binding and mode stay.
      yield* service.upsert({ ...input, threadId: null });
      assert.deepEqual(yield* storedMode, { thread_id: bound, thread_mode: "continue" });
      yield* service.runNow({ id: input.id });
      assert.deepEqual(yield* Ref.get(sends), [{ threadId: bound, freshContext: false }]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  { mode: "continue", fresh: false },
  { mode: "new_thread", fresh: null },
] as const)("a row dev's writer stored as $mode reads and runs as $mode", ({ mode, fresh }) =>
  Effect.gen(function* () {
    const { launched, sends, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = mode === "continue" ? "thread:dev-bound" : null;
      // The columns dev's saveTask writes: thread_mode follows thread_id, as migration 080 backfills.
      yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
        task_id: input.id,
        title: input.title,
        prompt: input.prompt,
        enabled: 1,
        schedule_json: JSON.stringify(input.schedule),
        project_id: input.projectId,
        thread_id: threadId,
        thread_mode: mode,
        workspace_strategy_json: JSON.stringify(input.workspaceStrategy),
        model_selection_json: JSON.stringify(input.modelSelection),
        runtime_mode: input.runtimeMode,
        interaction_mode: input.interactionMode,
        created_by: "user",
        creation_source: "web",
        created_at: "2026-11-16T00:00:00.000Z",
        updated_at: "2026-11-16T00:00:00.000Z",
        next_run_at: null,
        last_run_at: null,
        last_run_status: "never",
        last_run_error: null,
        run_count: 0,
      })}`;
      const [task] = (yield* service.list()).tasks;
      assert.equal(task?.threadMode, mode satisfies ScheduledTaskThreadMode);
      yield* service.runNow({ id: input.id });
      assert.lengthOf(yield* Ref.get(launched), fresh === null ? 1 : 0);
      assert.deepEqual(
        yield* Ref.get(sends),
        fresh === null
          ? []
          : [{ threadId: ThreadId.make("thread:dev-bound"), freshContext: fresh }],
      );
      assert.deepEqual(yield* storedMode, { thread_id: threadId, thread_mode: mode });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
