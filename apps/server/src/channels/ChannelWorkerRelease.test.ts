import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { preparationSettled } from "../orchestration-v2/testkit/preparationSettled.ts";
import { nextTurnSelectionHarness } from "../orchestration-v2/testkit/SteeringHarness.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLayers from "./ChannelLayers.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { workerLaunchIdsFor } from "./channelIds.ts";
import {
  goatInput,
  makeHarness,
  modelSelection,
  onlyTask,
  projectId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const providerStarts = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql`SELECT 1 FROM orchestration_v2_effect_outbox
    WHERE thread_id=${threadId} AND effect_type='provider-turn.start'`;

it.effect("a person's launch can use channel-like thread and message ids", () => {
  const harness = makeHarness({ realWorkerLaunch: true });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const { threadId } = yield* launches.launch({
      commandId: CommandId.make("person-launch"),
      threadId: ThreadId.make("channel-worker:fixture"),
      projectId,
      title: "Ordinary launch",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      createdBy: "user",
      creationSource: "web",
      initialMessage: {
        messageId: MessageId.make("channel-worker-message:fixture"),
        text: "Inspect fixtures",
        attachments: [],
      },
    });
    const prepared = yield* preparationSettled(threadId);
    assert.strictEqual(prepared.runs[0]?.status, "starting");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("releases an ordinary worker claimed before launch during rollback to #3797", () =>
  Effect.gen(function* () {
    const provider = yield* nextTurnSelectionHarness("rollback-channel-claim");
    const claimed = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    const harness = makeHarness({
      realWorkerLaunch: true,
      workerAdapter: provider.adapter,
      channelsLayer: ChannelLayers.layerServices.pipe(
        Layer.updateService(ThreadLaunch.ThreadLaunchService, (service) =>
          ThreadLaunch.ThreadLaunchService.of({
            ...service,
            launch: (input) =>
              Deferred.succeed(claimed, undefined).pipe(
                Effect.andThen(Deferred.await(ready)),
                Effect.andThen(service.launch(input)),
              ),
          }),
        ),
      ),
    });
    yield* Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const sql = yield* SqlClient.SqlClient;
      yield* gateway.ingest(goatInput("do: inspect fixtures", "rollback-claim"), rpcContext);
      const oldDispatch = yield* runtime.drain.pipe(Effect.forkChild);
      yield* Deferred.await(claimed);
      yield* Fiber.interrupt(oldDispatch);
      const { taskId, generation, status, worker } = yield* onlyTask;
      const { threadId } = workerLaunchIdsFor(taskId, generation);
      assert.strictEqual(status, "dispatching");
      assert.isUndefined(worker);
      assert.lengthOf(
        yield* sql`SELECT 1 FROM channel_task_events
          WHERE task_id = ${taskId} AND type = 'task.dispatch.claimed'`,
        1,
      );
      assert.isEmpty(
        yield* sql`SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}`,
      );
      // The older dispatcher commits the claim and brief without writing the generation table.
      yield* sql`DELETE FROM channel_worker_generations WHERE task_id = ${taskId}`;
      assert.isEmpty(yield* runMigrations());
      yield* Deferred.succeed(ready, undefined);
      yield* runtime.drain;
      assert.strictEqual((yield* preparationSettled(threadId)).runs[0]?.status, "starting");
      yield* runtime.drain;
      assert.lengthOf(yield* providerStarts(sql, threadId), 1);
      const effectWorker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* effectWorker.drain();
      assert.deepStrictEqual(
        provider.started.map((turn) => turn.providerThread.appThreadId),
        [threadId],
      );
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.scoped),
);

it.effect.each(["bound", "upgraded unbound", "rollback unbound", "rollback stale"] as const)(
  "releases an ordinary %s channel worker",
  (phase) =>
    Effect.gen(function* () {
      const preparing = yield* Deferred.make<void>();
      let branchReads = 0;
      const harness = makeHarness({
        realWorkerLaunch: true,
        getWorkerBranch: () =>
          Effect.gen(function* () {
            if (branchReads++ !== 1) return null;
            yield* Deferred.succeed(preparing, undefined);
            return yield* Effect.never;
          }),
      });
      yield* Effect.gen(function* () {
        yield* setupBot;
        const sql = yield* SqlClient.SqlClient;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* gateway.ingest(goatInput("do: inspect fixtures", "ordinary-worker"), rpcContext);
        yield* runtime.drain;
        const { taskId, generation, worker } = yield* onlyTask;
        if (worker?.runId === undefined) return assert.fail("Expected a bound worker run");
        yield* Deferred.await(preparing);
        assert.strictEqual(
          (yield* threads.getThreadProjection(worker.threadId)).runs[0]?.status,
          "preparing",
        );
        yield* sql`WITH RECURSIVE history(n) AS (
        VALUES (1) UNION ALL SELECT n + 1 FROM history WHERE n < 130
      )
      INSERT INTO channel_tasks (
        task_id, owner_id, conversation_id, status, version, generation, task_json, created_at, updated_at
      ) SELECT '00-unrelated-' || n, owner_id, conversation_id, 'dispatching', 1, 1, '{}', created_at, updated_at
      FROM channel_tasks, history WHERE task_id = ${taskId}`;
        if (phase === "upgraded unbound") {
          yield* sql`DROP TABLE IF EXISTS channel_worker_generations`;
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id > 178`;
          yield* sql`DROP TRIGGER channel_task_status_version`;
          yield* sql`DROP INDEX channel_task_views_by_task`;
          yield* sql`ALTER TABLE channel_tasks DROP COLUMN status_version`;
          yield* sql`DELETE FROM channel_runtime_state WHERE key = 'bot-task-activity-since'`;
          yield* sql`UPDATE channel_tasks SET status = 'dispatching', worker_thread_id = NULL
          WHERE task_id = ${taskId}`;
          yield* runMigrations();
        }
        if (phase === "rollback unbound" || phase === "rollback stale") {
          // The older writer leaves the new table and migration ledger alone.
          if (phase === "rollback unbound") {
            yield* sql`DELETE FROM channel_worker_generations WHERE task_id = ${taskId}`;
            yield* sql`UPDATE channel_tasks SET status = 'dispatching', worker_thread_id = NULL
              WHERE task_id = ${taskId}`;
            yield* sql`CREATE TEMP TRIGGER refuse_generation_repair
              BEFORE INSERT ON channel_worker_generations
              BEGIN SELECT RAISE(ABORT, 'generation repair unavailable'); END`;
            assert.isEmpty(yield* runMigrations());
            assert.isEmpty(
              yield* sql`SELECT 1 FROM channel_worker_generations WHERE task_id = ${taskId}`,
            );
            yield* sql`DROP TRIGGER refuse_generation_repair`;
          } else {
            const retired = workerLaunchIdsFor(taskId, generation - 1);
            yield* sql`UPDATE channel_worker_generations
              SET generation = ${generation - 1}, worker_thread_id = ${retired.threadId}
              WHERE task_id = ${taskId}`;
          }
          assert.isEmpty(yield* runMigrations());
          const launches = yield* ThreadLaunch.ThreadLaunchService;
          yield* launches.prepareRun({
            commandId: CommandId.make("recover-ordinary-worker"),
            threadId: worker.threadId,
            runId: worker.runId,
          });
          assert.strictEqual(
            (yield* preparationSettled(worker.threadId)).runs[0]?.status,
            "starting",
          );
          assert.lengthOf(yield* providerStarts(sql, worker.threadId), 1);
          return;
        }
        const reads: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        const observe: Statement.Transformer = (statement) =>
          Effect.sync(() => {
            const compiled = statement.compile();
            if (
              /\b(?:channel_tasks|scheduled_task_channel_inputs|auth_sessions)\b/.test(compiled[0])
            )
              reads.push(compiled);
            return statement;
          });
        yield* threads
          .dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make("direct-ordinary-release"),
            threadId: worker.threadId,
            runId: worker.runId,
          })
          .pipe(Effect.provideService(Statement.CurrentTransformer, observe));
        assert.lengthOf(yield* providerStarts(sql, worker.threadId), 1);
        assert.lengthOf(reads, 1);
        for (const [query, params] of reads) {
          const plan = yield* sql.unsafe<{ readonly detail: string }>(
            "EXPLAIN QUERY PLAN " + query,
            params,
          );
          assert.isTrue(plan.some(({ detail }) => detail.includes("(worker_thread_id=?)")));
          assert.isFalse(plan.some(({ detail }) => detail.startsWith("SCAN")));
        }
      }).pipe(Effect.provide(harness.layer));
    }),
);
