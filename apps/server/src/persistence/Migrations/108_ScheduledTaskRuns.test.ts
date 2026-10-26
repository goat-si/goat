import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./108_ScheduledTaskRuns.ts";

it.effect(
  "upgrades legacy tasks without inventing outcomes and preserves populated receipts when the body reruns",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 107 });
      for (const status of ["never", "running", "succeeded", "failed"]) {
        yield* sql`INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count)
        VALUES (${status},'Synthetic','Synthetic',1,'{}','project','{}','{}','full-access','default','user','web','2026-10-15','2026-10-15',${status},3)`;
      }
      assert.deepStrictEqual(yield* runMigrations(), [[108, "ScheduledTaskRuns"]]);
      assert.deepStrictEqual(yield* sql`SELECT DISTINCT last_firing_id FROM scheduled_tasks`, [
        { last_firing_id: null },
      ]);
      yield* migration;
      for (const kind of ["scheduled", "manual", "webhook"]) {
        yield* sql`INSERT INTO scheduled_task_runs (firing_id,task_id,task_created_at,message_id,trigger_kind,admitted_next_run_at,admitted_schedule_digest,admitted_enabled,dispatch_status,status,requested_at,dispatch_bookkept_at,snapshot_json)
        VALUES (${kind},'never','2026-10-15',${kind},${kind},NULL,'{}',1,'unknown','unknown','2026-10-15','2026-10-15','{}')`;
      }
      yield* sql`UPDATE scheduled_tasks SET last_firing_id='manual' WHERE task_id='never'`;
      const before = yield* sql`SELECT * FROM scheduled_task_runs ORDER BY firing_id`;
      yield* migration;
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM scheduled_task_runs ORDER BY firing_id`,
        before,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
      const objects = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE name LIKE 'scheduled_task_runs_%'`;
      assert.includeMembers(
        objects.map((o) => o.name),
        [
          "scheduled_task_runs_run",
          "scheduled_task_runs_task",
          "scheduled_task_runs_dispatch",
          "scheduled_task_runs_delete",
        ],
      );
      yield* sql`INSERT INTO scheduled_task_runs SELECT * FROM scheduled_task_runs WHERE firing_id='manual'`.pipe(
        Effect.flip,
      );
      yield* sql`UPDATE scheduled_task_runs SET dispatch_status='accepted',status='unknown' WHERE firing_id='manual'`.pipe(
        Effect.flip,
      );
      yield* sql`DELETE FROM scheduled_tasks WHERE task_id='never'`;
      assert.deepStrictEqual(yield* sql`SELECT * FROM scheduled_task_runs`, []);
      assert.equal((yield* sql`SELECT * FROM scheduled_tasks`).length, 3);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
