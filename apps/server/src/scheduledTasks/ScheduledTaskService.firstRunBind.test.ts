import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ScheduledTaskId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
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
  id: ScheduledTaskId.make("task:first-run-bind"),
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

interface Recorded {
  readonly launched: Ref.Ref<ReadonlyArray<ThreadId>>;
  readonly sends: Ref.Ref<ReadonlyArray<ThreadId>>;
}

/**
 * One server lifetime over the shared database. With `stopAfterLaunch`, the server stops once the
 * launch has committed its thread, before the first run can bind it.
 */
const serverLifetime = (recorded: Recorded, options: { readonly stopAfterLaunch: boolean }) => {
  const launchLayer = Layer.unwrap(
    Effect.gen(function* () {
      const launch = syntheticLaunch(yield* EventSink.EventSinkV2);
      return Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (request) =>
          Effect.gen(function* () {
            const result = yield* launch(request).pipe(Effect.orDie);
            yield* Ref.update(recorded.launched, (all) => [...all, result.threadId]);
            if (options.stopAfterLaunch) return yield* Effect.interrupt;
            return result;
          }),
      });
    }),
  ).pipe(Layer.provide(layerSink));
  return ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        launchLayer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed({ deletedAt: null } as never),
          sendToThread: (send) =>
            Ref.update(recorded.sends, (all) => [...all, send.threadId]).pipe(
              Effect.as({ run: { id: "run:sent", threadId: send.threadId } } as never),
            ),
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
};

const boundThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ thread_id: string | null }>`
    SELECT thread_id FROM scheduled_tasks WHERE task_id = ${input.id}`;
  return rows[0]?.thread_id ?? null;
});

/** Saves the task and stops the server between its first run's launch and its bind. */
const stopBeforeFirstBind = (recorded: Recorded, threadMode: "continue" | "fresh_session") =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    yield* service.upsert({ ...input, threadMode });
    yield* Effect.exit(service.runNow({ id: input.id }));
  }).pipe(Effect.provide(serverLifetime(recorded, { stopAfterLaunch: true })));

it.effect.each(["continue", "fresh_session"] as const)(
  "regression goat#3581: a %s task stopped before its first bind keeps one thread after a restart",
  (threadMode) =>
    Effect.gen(function* () {
      const recorded = {
        launched: yield* Ref.make<ReadonlyArray<ThreadId>>([]),
        sends: yield* Ref.make<ReadonlyArray<ThreadId>>([]),
      };
      yield* stopBeforeFirstBind(recorded, threadMode);
      const [first] = yield* Ref.get(recorded.launched);
      assert.isDefined(first);
      assert.isNull(yield* boundThread);

      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* TestClock.adjust("1 second");
        yield* service.runNow({ id: input.id });
      }).pipe(Effect.provide(serverLifetime(recorded, { stopAfterLaunch: false })));

      assert.deepEqual(yield* Ref.get(recorded.launched), [first]);
      assert.deepEqual(yield* Ref.get(recorded.sends), [first]);
      assert.equal(yield* boundThread, first);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a task bound to another thread before the restart is not rebound to its first run's",
  () =>
    Effect.gen(function* () {
      const recorded = {
        launched: yield* Ref.make<ReadonlyArray<ThreadId>>([]),
        sends: yield* Ref.make<ReadonlyArray<ThreadId>>([]),
      };
      yield* stopBeforeFirstBind(recorded, "continue");
      const chosen = ThreadId.make("thread:chosen");
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* service.upsert({ ...input, threadId: chosen, threadMode: "continue" });
      }).pipe(Effect.provide(serverLifetime(recorded, { stopAfterLaunch: false })));
      assert.equal(yield* boundThread, chosen);

      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* TestClock.adjust("1 second");
        yield* service.runNow({ id: input.id });
      }).pipe(Effect.provide(serverLifetime(recorded, { stopAfterLaunch: false })));

      assert.equal(yield* boundThread, chosen);
      assert.deepEqual(yield* Ref.get(recorded.sends), [chosen]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
