import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("indexes message ordinals while retaining malformed payloads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 167 });
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('bad', 'thread', 1, 'assistant_message', 'completed', '2026-01-01', '{bad'),
      ('good', 'thread', 2, 'user_message', 'completed', '2026-01-01', '{"messageId":"m"}')`;
    yield* runMigrations();
    const plan = yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
      SELECT json_extract(payload_json, '$.messageId'), MIN(ordinal)
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = 'thread' AND type IN ('user_message', 'assistant_message')
        AND json_valid(payload_json)
      GROUP BY json_extract(payload_json, '$.messageId')`;
    assert.isTrue(
      plan.some((row) =>
        row.detail.includes("orchestration_v2_projection_turn_items_message_ordinal_idx"),
      ),
    );
    const rows =
      yield* sql`SELECT json_extract(payload_json, '$.messageId') AS id, MIN(ordinal) AS ordinal
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = 'thread' AND type IN ('user_message', 'assistant_message')
        AND json_valid(payload_json)
      GROUP BY json_extract(payload_json, '$.messageId')`;
    assert.deepEqual(rows, [{ id: "m", ordinal: 2 }]);
    const all = yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items`;
    assert.equal(all.length, 2);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
