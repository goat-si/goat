import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { deliveryEvidence } from "../../scheduledTasks/webhookDeliveryRow.ts";
import { runMigrations } from "../Migrations.ts";

const forbidPayloadRewrite = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 177 });
  yield* sql`INSERT INTO scheduled_task_webhook_deliveries (
    delivery_id, task_id, received_at, method, query, headers_json, body, body_bytes,
    body_truncated, outcome, signature_verified, missing_fields_json
  ) VALUES ('large', 'work', '2026-11-21', 'POST', '', '{}', hex(zeroblob(32768)), 65536,
    0, 'accepted', 1, '[]')`;
  yield* sql`INSERT INTO scheduled_task_channel_inputs (firing_id, task_id, payload_json, state, created_at)
    VALUES ('firing', 'work', '{"webhookDeliveryId":"large"}', 'ingested', '2026-11-21')`;
  yield* sql`CREATE TRIGGER preserve_webhook_payload BEFORE UPDATE ON scheduled_task_webhook_deliveries
    BEGIN SELECT RAISE(ABORT, 'backfill rewrote a stored delivery'); END`;
  yield* runMigrations();
  assert.deepStrictEqual(
    yield* sql`SELECT ${deliveryEvidence(sql)} FROM scheduled_task_webhook_deliveries d`,
    [{ pending_window: 0, has_accepted_firing: 1 }],
  );
});

it.effect("backfills firing evidence without rewriting payload rows", () =>
  forbidPayloadRewrite.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("preserves proven firings when upgrading a delivery log", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = "2026-11-21T00:00:00.000Z";
    yield* runMigrations({ toMigrationInclusive: 177 });
    yield* sql`INSERT INTO scheduled_task_webhook_deliveries (
      delivery_id, task_id, received_at, method, query, headers_json, body, body_bytes,
      body_truncated, outcome, signature_verified, missing_fields_json
    ) VALUES
      ('ran', 'work', ${at}, 'POST', '', '{}', '', 0, 0, 'accepted', 1, '[]'),
      ('pruned', 'work', ${at}, 'POST', '', '{}', '', 0, 0, 'accepted', 1, '[]'),
      ('pending', 'work', ${at}, 'POST', '', '{}', '', 0, 0, 'accepted', 1, '[]'),
      ('inbox-only', 'work', ${at}, 'POST', '', '{}', '', 0, 0, 'accepted', 1, '[]'),
      ('inbox-failed', 'work', ${at}, 'POST', '', '{}', '', 0, 0, 'accepted', 1, '[]')`;
    yield* sql`INSERT INTO scheduled_task_runs (
      firing_id, task_id, task_created_at, message_id, trigger_kind, admitted_schedule_digest,
      admitted_enabled, webhook_delivery_id, dispatch_status, status, requested_at,
      dispatch_bookkept_at, completed_at, snapshot_json
    ) VALUES ('run', 'work', ${at}, 'message', 'webhook', 'fixture',
      1, 'ran', 'accepted', 'completed', ${at}, ${at}, ${at}, '{}')`;
    yield* sql`INSERT INTO scheduled_task_channel_inputs (
      firing_id, task_id, payload_json, state, created_at, settled_at
    ) VALUES ('pruned-run', 'work', '{"webhookDeliveryId":"pruned"}', 'settled', ${at}, ${at}),
      ('pending-run', 'work', '{"webhookDeliveryId":"pending"}', 'pending', ${at}, NULL)`;
    yield* sql`INSERT INTO channel_conversations
      (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
      VALUES ('conversation', 'owner', 'goat', 'goat', 'bot', ${at})`;
    yield* sql`INSERT INTO channel_bindings
      (binding_id, conversation_id, connection_id, reply_address_json, last_activity_at)
      VALUES ('binding', 'conversation', 'goat', '{}', ${at})`;
    yield* sql`INSERT INTO channel_inbox (
      input_id, owner_id, kind, connection_id, idempotency_key, content_hash, conversation_id,
      binding_id, message_json, state, accepted_at, failure_json
    ) VALUES
      ('reply', 'owner', 'goat', 'goat', 'routine:scheduled-task:work:webhook:inbox-only',
        'hash', 'conversation', 'binding', '{}', 'replied', ${at}, NULL),
      ('failed', 'owner', 'goat', 'goat', 'routine:scheduled-task:work:webhook:inbox-failed',
        'hash', 'conversation', 'binding', '{}', 'replied', ${at}, '{"message":"failed"}')`;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT d.delivery_id, ${deliveryEvidence(sql)}
        FROM scheduled_task_webhook_deliveries d ORDER BY d.delivery_id`,
      [
        { delivery_id: "inbox-failed", pending_window: 0, has_accepted_firing: 0 },
        { delivery_id: "inbox-only", pending_window: 0, has_accepted_firing: 1 },
        { delivery_id: "pending", pending_window: 0, has_accepted_firing: 0 },
        { delivery_id: "pruned", pending_window: 0, has_accepted_firing: 1 },
        { delivery_id: "ran", pending_window: 0, has_accepted_firing: 1 },
      ],
    );
    yield* sql`DELETE FROM scheduled_task_webhook_deliveries WHERE delivery_id = 'inbox-only'`;
    assert.isEmpty(
      yield* sql`SELECT 1 FROM scheduled_task_webhook_firings
      WHERE delivery_id = 'inbox-only'`,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("carries firing evidence from a database opened by the earlier draft", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 177 });
    yield* sql`ALTER TABLE scheduled_task_webhook_deliveries
      ADD COLUMN firing_accepted INTEGER NOT NULL DEFAULT 0`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (178, 'WebhookDeliveryFiringEvidence')`;
    yield* sql`INSERT INTO scheduled_task_webhook_deliveries (
      delivery_id, task_id, received_at, method, query, headers_json, body, body_bytes,
      body_truncated, outcome, signature_verified, missing_fields_json, firing_accepted
    ) VALUES ('draft', 'work', '2026-11-21', 'POST', '', '{}', '', 0, 0, 'accepted', 1, '[]', 1)`;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT ${deliveryEvidence(sql)} FROM scheduled_task_webhook_deliveries d`,
      [{ pending_window: 0, has_accepted_firing: 1 }],
    );
    assert.isEmpty(yield* runMigrations());
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
