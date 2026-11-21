import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

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
      ('pending', 'work', ${at}, 'POST', '', '{}', '', 0, 0, 'accepted', 1, '[]')`;
    yield* sql`INSERT INTO scheduled_task_runs (
      firing_id, task_id, task_created_at, message_id, trigger_kind, admitted_schedule_digest,
      admitted_enabled, webhook_delivery_id, dispatch_status, status, requested_at,
      dispatch_bookkept_at, completed_at, snapshot_json
    ) VALUES ('run', 'work', ${at}, 'message', 'webhook', 'fixture',
      1, 'ran', 'accepted', 'completed', ${at}, ${at}, ${at}, '{}')`;
    assert.deepStrictEqual(yield* runMigrations(), [[178, "WebhookDeliveryFiringEvidence"]]);
    assert.deepStrictEqual(
      yield* sql`SELECT delivery_id, firing_accepted
        FROM scheduled_task_webhook_deliveries ORDER BY delivery_id`,
      [
        { delivery_id: "pending", firing_accepted: 0 },
        { delivery_id: "ran", firing_accepted: 1 },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
