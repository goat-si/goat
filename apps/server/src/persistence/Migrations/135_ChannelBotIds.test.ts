import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades stored channel inputs and tasks as the main bot's", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 134 });
    yield* sql`INSERT INTO channel_conversations
      (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
      VALUES ('c1', 'o1', 'goat', 'goat', 't1', 'now')`;
    yield* sql`INSERT INTO channel_bindings
      (binding_id, conversation_id, connection_id, reply_address_json, last_activity_at)
      VALUES ('b1', 'c1', 'goat', '{}', 'now')`;
    yield* sql`INSERT INTO channel_inbox (input_id, owner_id, kind, connection_id, idempotency_key,
      content_hash, conversation_id, binding_id, message_json, state, accepted_at)
      VALUES ('i1', 'o1', 'goat', 'goat', 'k1', 'h', 'c1', 'b1', '{}', 'replied', 'now')`;
    yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version,
      generation, task_json, created_at, updated_at)
      VALUES ('t1', 'o1', 'c1', 'running', 1, 1, '{}', 'now', 'now')`;

    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 135 }), [
      [135, "ChannelBotIds"],
    ]);
    const inbox = yield* sql<{ bot_id: string }>`SELECT bot_id FROM channel_inbox`;
    const tasks = yield* sql<{ bot_id: string }>`SELECT bot_id FROM channel_tasks`;
    assert.deepStrictEqual([...inbox, ...tasks], [{ bot_id: "main" }, { bot_id: "main" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
