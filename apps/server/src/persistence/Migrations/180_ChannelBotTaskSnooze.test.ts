import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

describe("bot work upgrade", () => {
  it.effect("preserves a pre-snooze task and its view while adding the status revision", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 179 });
      const time = "2026-10-12T00:00:00.000Z";
      yield* sql`INSERT INTO channel_conversations
        (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
        VALUES ('bot', 'owner', 'goat', 'bot', 'bot', ${time})`;
      yield* sql`INSERT INTO channel_tasks
        (task_id, owner_id, conversation_id, status, version, generation, task_json, created_at, updated_at)
        VALUES ('task', 'owner', 'bot', 'running', 1, 1, '{}', ${time}, ${time})`;
      const view = '{"taskId":"task","pinnedAt":null,"doneAt":null,"readThrough":null}';
      yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES ('task-view:owner:task', ${view}, ${time})`;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 180 }), [
        [180, "ChannelBotTaskSnooze"],
      ]);
      const [task] = yield* sql<{ readonly status: string; readonly status_version: number }>`
        SELECT status, status_version FROM channel_tasks WHERE task_id = 'task'`;
      assert.deepStrictEqual(task, { status: "running", status_version: 0 });
      const [stored] = yield* sql<{ readonly value_json: string }>`
        SELECT value_json FROM channel_runtime_state WHERE key = 'task-view:owner:task'`;
      assert.strictEqual(stored?.value_json, view);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "rolls back migration 180 when its activity marker insert aborts and retries cleanly",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 179 });
        yield* sql`
        CREATE TRIGGER abort_activity_marker BEFORE INSERT ON channel_runtime_state
        WHEN NEW.key = 'bot-task-activity-since'
        BEGIN SELECT RAISE(ABORT, 'injected activity marker failure'); END
      `;
        const migrate = runMigrations({ toMigrationInclusive: 180 });
        const failed = yield* Effect.exit(migrate);
        if (!Exit.isFailure(failed)) return assert.fail("expected migration 180 to abort");
        assert.include(Cause.pretty(failed.cause), "injected activity marker failure");
        const columns = yield* sql`SELECT name FROM pragma_table_info('channel_tasks')
        WHERE name = 'status_version'`;
        assert.isEmpty(columns);
        assert.isEmpty(
          yield* sql`SELECT name FROM sqlite_master
        WHERE name IN ('channel_task_status_version', 'channel_task_views_by_task')`,
        );
        assert.isEmpty(
          yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 180`,
        );
        assert.isEmpty(
          yield* sql`SELECT key FROM channel_runtime_state WHERE key = 'bot-task-activity-since'`,
        );

        yield* sql`DROP TRIGGER abort_activity_marker`;
        assert.deepStrictEqual(yield* migrate, [[180, "ChannelBotTaskSnooze"]]);
        assert.deepStrictEqual(
          yield* sql`SELECT key FROM channel_runtime_state WHERE key = 'bot-task-activity-since'`,
          [{ key: "bot-task-activity-since" }],
        );
        assert.isEmpty(yield* migrate);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
