import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("bot work upgrade", (it) => {
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
    }),
  );
});
