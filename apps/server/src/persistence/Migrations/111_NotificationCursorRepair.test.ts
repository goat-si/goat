import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "./111_NotificationCursorRepair.ts";
import { runMigrations } from "../Migrations.ts";

const idlePrompt = JSON.stringify({
  text: " /Compact ",
  createdBy: "agent",
  creationSource: "server",
});

// A database as nightly 282 left it: 110's backfill and the live cursor counted idle compactions.
const seedThroughShipped110 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 109 });
  for (const thread of ["quiet", "only-quiet", "failed", "later", "shared", "healthy"])
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
      VALUES (${thread},'project','Synthetic','codex','codex','full-access','default','2026-10-15','2026-10-15','{}')`;
  for (const thread of ["quiet", "only-quiet", "failed", "later", "shared"])
    yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
      VALUES (${`${thread}-prompt`},${thread},'user',0,'2026-10-15','2026-10-15',${idlePrompt})`;
  const runs = [
    ["quiet-user", "quiet", 1, "2026-10-15T02:00:00.000Z", "user-prompt"],
    ["quiet-idle", "quiet", 2, "2026-10-15T03:00:00.000Z", "quiet-prompt"],
    ["only-quiet-idle", "only-quiet", 1, "2026-10-15T03:00:00.000Z", "only-quiet-prompt"],
    ["failed-idle", "failed", 1, "2026-10-15T04:00:00.000Z", "failed-prompt"],
    ["later-idle", "later", 1, "2026-10-15T03:00:00.000Z", "later-prompt"],
    ["later-user", "later", 2, "2026-10-15T05:00:00.000Z", "user-prompt"],
    ["shared-idle", "shared", 1, "2026-10-15T03:00:00.000Z", "shared-prompt"],
    ["shared-user", "shared", 2, "2026-10-15T03:00:00.000Z", "user-prompt"],
    ["healthy-user", "healthy", 1, "2026-10-15T06:00:00.000Z", "user-prompt"],
  ] as const;
  for (const [run, thread, ordinal, completedAt, userMessageId] of runs)
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json)
      VALUES (${run},${thread},${ordinal},'codex','completed','2026-10-15',${completedAt},${JSON.stringify({ userMessageId })})`;
  yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json)
    VALUES ('failed-compaction','failed','failed-idle',0,'compaction','failed','2026-10-15','{}')`;
  const history = [
    ["quiet-failed-attempt", "failed", "2026-10-15T02:30:00.000Z"],
    ["quiet-retry", "completed", "2026-10-15T03:00:00.000Z"],
  ] as const;
  for (const [index, [event, status, completedAt]] of history.entries())
    yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
      VALUES (${event},'thread','quiet',${index},'run.updated','2026-10-15','server',${JSON.stringify({ id: "quiet-idle", status, completedAt, userMessageId: "quiet-prompt" })},'{}',2)`;
  assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 110 }), [
    [110, "ScheduledTaskNotificationPolicy"],
  ]);
});

const cursors = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly thread_id: string; readonly cursor: string | null }>`
    SELECT thread_id, json_extract(payload_json,'$.notificationCompletedAt') AS cursor
    FROM orchestration_v2_projection_threads ORDER BY thread_id`;
});

const threadRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM orchestration_v2_projection_threads ORDER BY thread_id`;
});

it.effect(
  "moves cursors that only a quiet idle compaction set back to the last notifying completion",
  () =>
    Effect.gen(function* () {
      yield* seedThroughShipped110;
      assert.deepStrictEqual(yield* cursors, [
        { thread_id: "failed", cursor: "2026-10-15T04:00:00.000Z" },
        { thread_id: "healthy", cursor: "2026-10-15T06:00:00.000Z" },
        { thread_id: "later", cursor: "2026-10-15T05:00:00.000Z" },
        { thread_id: "only-quiet", cursor: "2026-10-15T03:00:00.000Z" },
        { thread_id: "quiet", cursor: "2026-10-15T03:00:00.000Z" },
        { thread_id: "shared", cursor: "2026-10-15T03:00:00.000Z" },
      ]);
      assert.deepStrictEqual(yield* runMigrations(), [[111, "NotificationCursorRepair"]]);
      assert.deepStrictEqual(yield* cursors, [
        { thread_id: "failed", cursor: "2026-10-15T04:00:00.000Z" },
        { thread_id: "healthy", cursor: "2026-10-15T06:00:00.000Z" },
        { thread_id: "later", cursor: "2026-10-15T05:00:00.000Z" },
        { thread_id: "only-quiet", cursor: null },
        { thread_id: "quiet", cursor: "2026-10-15T02:30:00.000Z" },
        { thread_id: "shared", cursor: "2026-10-15T03:00:00.000Z" },
      ]);
      const repaired = yield* threadRows;
      yield* migration;
      assert.deepStrictEqual(yield* threadRows, repaired);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("leaves a database without idle compaction cursors unchanged", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 110 });
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
      VALUES ('visited','project','Synthetic','codex','codex','full-access','default','2026-10-15','2026-10-15',
        '{"notificationCompletedAt":"2026-10-15T01:00:00.000Z","lastVisitedAt":"2026-10-15T02:00:00.000Z"}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
      VALUES ('empty','project','Synthetic','codex','codex','full-access','default','2026-10-15','2026-10-15','{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json)
      VALUES ('visited-run','visited',1,'codex','completed','2026-10-15','2026-10-15T01:00:00.000Z','{}')`;
    const before = yield* threadRows;
    assert.deepStrictEqual(yield* runMigrations(), [[111, "NotificationCursorRepair"]]);
    assert.deepStrictEqual(yield* threadRows, before);
    yield* migration;
    assert.deepStrictEqual(yield* threadRows, before);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
