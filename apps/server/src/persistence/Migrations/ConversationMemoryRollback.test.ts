import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import { setConversationMemoryEnabled } from "../../memory/conversationMemoryPolicy.ts";

it.effect("migration 186 rolls back its schema and ledger after an index failure and retries", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 185 });
    yield* sql`INSERT INTO channel_conversations (conversation_id,owner_id,kind,connection_id,conversation_key,last_activity_at)
      VALUES ('c','owner','slack','s','c','now')`;
    const before = yield* sql`SELECT * FROM channel_conversations`;
    yield* sql`CREATE INDEX conversation_memory_run_inputs ON channel_conversations(owner_id)`;
    const migrate = runMigrations({ toMigrationInclusive: 186 });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(migrate)));
    assert.isEmpty(
      yield* sql`SELECT name FROM sqlite_master WHERE name IN ('conversation_memory_policy','conversation_memory_policy_boundary')`,
    );
    assert.isEmpty(
      yield* sql`SELECT name FROM pragma_table_info('channel_inbox') WHERE name='conversation_memory_enabled'`,
    );
    assert.isEmpty(
      yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id=186`,
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM channel_conversations`, before);
    yield* sql`DROP INDEX conversation_memory_run_inputs`;
    assert.deepStrictEqual(yield* migrate, [[186, "ConversationMemoryPolicy"]]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM channel_conversations`, before);
    assert.isEmpty(yield* migrate);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("migration 187 rolls back backfill, schema and ledger on failure and retries", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 186 });
    yield* setConversationMemoryEnabled(sql, false);
    yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
      VALUES ('event','thread','thread',1,'message.updated','now','user','{"id":"message","role":"user"}','{}',2)`;
    yield* sql`INSERT INTO channel_conversations (conversation_id,owner_id,kind,connection_id,conversation_key,last_activity_at)
      VALUES ('c','owner','slack','s','c','now')`;
    yield* sql`INSERT INTO channel_bindings (binding_id,conversation_id,connection_id,reply_address_json,last_activity_at)
      VALUES ('b','c','s','{}','now')`;
    yield* sql`INSERT INTO channel_inbox (input_id,owner_id,kind,connection_id,idempotency_key,content_hash,conversation_id,binding_id,message_json,state,accepted_at,conversation_memory_enabled)
      VALUES ('i','owner','slack','s','i','hash','c','b','{}','accepted','now',0)`;
    yield* sql`INSERT INTO channel_tasks (task_id,owner_id,conversation_id,status,version,generation,task_json,created_at,updated_at)
      VALUES ('t','owner','c','dispatching',1,1,'{"originInputId":"i","target":{"memoryGrantCeiling":"read_write"}}','now','now')`;
    const before = yield* sql`SELECT task_json FROM channel_tasks`;
    yield* sql`CREATE TRIGGER abort_conversation_backfill BEFORE UPDATE ON channel_tasks
      BEGIN SELECT RAISE(ABORT, 'injected backfill failure'); END`;
    const migrate = runMigrations({ toMigrationInclusive: 187 });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(migrate)));
    assert.isEmpty(
      yield* sql`SELECT name FROM sqlite_master WHERE name IN ('conversation_memory_excluded_messages','conversation_memory_mark_paused_message','conversation_memory_delete_thread')`,
    );
    assert.isEmpty(
      yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id=187`,
    );
    assert.deepStrictEqual(yield* sql`SELECT task_json FROM channel_tasks`, before);
    assert.strictEqual(
      (yield* sql`SELECT event_id FROM orchestration_events WHERE event_id='event'`).length,
      1,
    );
    yield* sql`DROP TRIGGER abort_conversation_backfill`;
    assert.deepStrictEqual(yield* migrate, [[187, "ConversationMemoryExcludedMessages"]]);
    assert.deepStrictEqual(
      yield* sql`SELECT thread_id,message_id FROM conversation_memory_excluded_messages`,
      [{ thread_id: "thread", message_id: "message" }],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT json_extract(task_json,'$.target.memoryGrantCeiling') AS grant_ceiling FROM channel_tasks`,
      [{ grant_ceiling: "none" }],
    );
    assert.isEmpty(yield* migrate);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
