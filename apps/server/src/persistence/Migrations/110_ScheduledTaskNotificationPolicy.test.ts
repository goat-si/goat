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

it.effect(
  "backfills unread cursors without GOAT's quiet idle compactions but keeps their failures",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 109 });
      for (const thread of ["quiet", "failed"])
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
        VALUES (${thread},'project','Synthetic','codex','codex','full-access','default','2026-10-15','2026-10-15','{}')`;
      const prompt = JSON.stringify({
        text: " /Compact ",
        createdBy: "agent",
        creationSource: "server",
      });
      for (const [message, thread] of [
        ["quiet-prompt", "quiet"],
        ["failed-prompt", "failed"],
      ])
        yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
        VALUES (${message},${thread},'user',0,'2026-10-15','2026-10-15',${prompt})`;
      const runs = [
        ["user-run", "quiet", 1, "2026-10-15T02:00:00.000Z", "user-prompt"],
        ["quiet-run", "quiet", 2, "2026-10-15T03:00:00.000Z", "quiet-prompt"],
        ["failed-run", "failed", 1, "2026-10-15T04:00:00.000Z", "failed-prompt"],
      ] as const;
      for (const [run, thread, ordinal, completedAt, userMessageId] of runs)
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json)
        VALUES (${run},${thread},${ordinal},'codex','completed','2026-10-15',${completedAt},${JSON.stringify({ userMessageId })})`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json)
      VALUES ('failed-compaction','failed','failed-run',0,'compaction','failed','2026-10-15','{}')`;
      const history = [
        ["quiet-failed-attempt", "failed", "2026-10-15T02:30:00.000Z"],
        ["quiet-retry", "completed", "2026-10-15T03:00:00.000Z"],
      ] as const;
      for (const [index, [event, status, completedAt]] of history.entries())
        yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
        VALUES (${event},'thread','quiet',${index},'run.updated','2026-10-15','server',${JSON.stringify({ id: "quiet-run", status, completedAt, userMessageId: "quiet-prompt" })},'{}',2)`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT thread_id, json_extract(payload_json,'$.notificationCompletedAt') AS cursor
        FROM orchestration_v2_projection_threads ORDER BY thread_id`,
        [
          { thread_id: "failed", cursor: "2026-10-15T04:00:00.000Z" },
          { thread_id: "quiet", cursor: "2026-10-15T02:30:00.000Z" },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
