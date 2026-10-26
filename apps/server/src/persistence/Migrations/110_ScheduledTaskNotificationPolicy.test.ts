import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "./110_ScheduledTaskNotificationPolicy.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades policy and notification metadata without losing receipts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 109 });
    yield* sql`INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count) VALUES ('task','Synthetic','Synthetic',1,'{}','project','{}','{}','full-access','default','user','web','2026-10-15','2026-10-15','never',0)`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
      VALUES ('thread','project','Synthetic','codex','codex','full-access','default','2026-10-15','2026-10-15','{}')`;
    yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
      VALUES ('historical-completion','thread','thread',0,'run.updated','2026-10-15','server','{"completedAt":"2026-10-15T01:00:00.000Z"}','{}',2)`;
    yield* sql`INSERT INTO thread_run_results(thread_id,run_id,report_json,reported_at) VALUES ('thread','run','{"outcome":"succeeded"}','2026-10-15')`;
    const reports = yield* sql`SELECT * FROM thread_run_results`;
    assert.deepStrictEqual(yield* runMigrations(), [[110, "ScheduledTaskNotificationPolicy"]]);
    assert.deepStrictEqual(yield* sql`SELECT notification_policy FROM scheduled_tasks`, [
      { notification_policy: "all_runs" },
    ]);
    const columns = yield* sql<{
      name: string;
    }>`PRAGMA table_info(orchestration_v2_projection_runs)`;
    assert.include(
      columns.map((c) => c.name),
      "completion_notification",
    );
    assert.deepStrictEqual(
      yield* sql`SELECT json_extract(payload_json,'$.notificationCompletedAt') AS cursor FROM orchestration_v2_projection_threads`,
      [{ cursor: "2026-10-15T01:00:00.000Z" }],
    );
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.notificationCompletedAt','2026-10-16T01:00:00.000Z')`;
    yield* migration;
    assert.deepStrictEqual(
      yield* sql`SELECT json_extract(payload_json,'$.notificationCompletedAt') AS cursor FROM orchestration_v2_projection_threads`,
      [{ cursor: "2026-10-16T01:00:00.000Z" }],
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM thread_run_results`, reports);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
