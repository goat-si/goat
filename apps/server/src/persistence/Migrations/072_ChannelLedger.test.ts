import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import ChannelLedgerMigration from "./072_ChannelLedger.ts";

const channelTables = [
  "channel_bindings",
  "channel_conversations",
  "channel_identities",
  "channel_identity_links",
  "channel_inbox",
  "channel_outbox",
  "channel_runtime_state",
  "channel_task_events",
  "channel_tasks",
];

it.effect("adds the channel ledger to a database at schema 65 and keeps existing rows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 71 });
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, provider, status, updated_at, payload_json)
      VALUES ('existing', 'codex', 'idle', '2026-10-12', '{}')`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 72 }), [
      [72, "ChannelLedger"],
    ]);
    const tables = yield* sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'channel_%' ORDER BY name`;
    assert.deepStrictEqual(
      tables.map((table) => table.name),
      channelTables,
    );
    const kept = yield* sql<{ provider_thread_id: string }>`
      SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads`;
    assert.deepStrictEqual(kept, [{ provider_thread_id: "existing" }]);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 72 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("runs again over its own schema, as a relocated migration id would", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
      VALUES ('kept', '{}', 'now')`;
    yield* ChannelLedgerMigration;
    const kept = yield* sql<{ key: string }>`SELECT key FROM channel_runtime_state`;
    assert.deepStrictEqual(kept, [{ key: "kept" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rejects a second input with the same scoped idempotency key", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`INSERT INTO channel_conversations
      (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
      VALUES ('conv', 'owner', 'slack', 'slack-1', 'T1:C1:1', 'now')`;
    yield* sql`INSERT INTO channel_bindings
      (binding_id, conversation_id, connection_id, reply_address_json, last_activity_at)
      VALUES ('binding', 'conv', 'slack-1', '{}', 'now')`;
    const insert = (inputId: string) => sql`INSERT INTO channel_inbox
      (input_id, owner_id, kind, connection_id, idempotency_key, content_hash, conversation_id,
       binding_id, message_json, state, accepted_at)
      VALUES (${inputId}, 'owner', 'slack', 'slack-1', 'T1:Ev1', 'hash', 'conv', 'binding', '{}',
       'accepted', 'now')`;
    yield* insert("input-1");
    const second = yield* Effect.exit(insert("input-2"));
    assert.strictEqual(second._tag, "Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
