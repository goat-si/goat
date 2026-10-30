import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect.each(["client", "server"] as const)(
  "backfills a past %s approval from the event history",
  (actor) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 119 });
      const payload = JSON.stringify({
        type: "human_handoff",
        handoff: {
          target: { path: "computer_use.grant" },
          state: "completed",
          actor: { type: actor },
        },
      });
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES ('approval', 'thread', 'thread', 1, 'turn-item.updated', '2026-10-30', 'server', ${payload}, '{}', 2)`;
      yield* runMigrations({ toMigrationInclusive: 120 });
      assert.equal(
        (yield* sql`SELECT id FROM computer_use_person_approval`).length,
        actor === "client" ? 1 : 0,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "first message revisions can be looked up by thread and message id through the index",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 120 });
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT sequence FROM orchestration_events
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        AND stream_id = 'thread:test' AND event_type = 'message.updated'
        AND json_extract(payload_json, '$.id') = 'message:test'
      ORDER BY sequence LIMIT 1`;
      assert.isTrue(plan.some((row) => row.detail.includes("computer_use_first_message_event")));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
