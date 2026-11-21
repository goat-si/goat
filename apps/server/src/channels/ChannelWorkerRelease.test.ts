import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { preparationSettled } from "../orchestration-v2/testkit/preparationSettled.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
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

it.effect.each(["bound", "upgraded unbound"] as const)(
  "release of an ordinary %s channel worker makes one indexed generation read",
  (phase) =>
    Effect.gen(function* () {
      const preparing = yield* Deferred.make<void>();
      let branchReads = 0;
      const harness = makeHarness({
        realWorkerLaunch: true,
        getWorkerBranch: () =>
          Effect.gen(function* () {
            if (branchReads++ === 0) return null;
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
        const { taskId, worker } = yield* onlyTask;
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
          yield* sql`UPDATE channel_tasks SET status = 'dispatching', worker_thread_id = NULL
          WHERE task_id = ${taskId}`;
          yield* runMigrations();
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
