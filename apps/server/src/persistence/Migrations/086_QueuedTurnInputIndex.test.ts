import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades an old queued-input index and keeps malformed rows out of indexed reads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 166 });
    yield* sql`DROP INDEX orchestration_v2_projection_turn_items_queued_input_idx`;
    yield* sql`CREATE INDEX orchestration_v2_projection_turn_items_queued_input_idx
      ON orchestration_v2_projection_turn_items(run_id)
      WHERE type = 'user_message' AND json_extract(payload_json, '$.inputIntent') = 'queued_turn'`;
    yield* runMigrations();
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES
        ('bad', 'thread-1', 'run-1', 1, 'user_message', 'completed', '2026-11-14T00:00:00Z', '{bad'),
        ('queued', 'thread-1', 'run-1', 2, 'user_message', 'completed', '2026-11-14T00:00:00Z', '{"inputIntent":"queued_turn"}')
    `;
    const rows = yield* sql<{ readonly turn_item_id: string }>`
      SELECT turn_item_id FROM orchestration_v2_projection_turn_items
      INDEXED BY orchestration_v2_projection_turn_items_queued_input_idx
      WHERE run_id = 'run-1' AND type = 'user_message' AND json_valid(payload_json)
        AND json_extract(payload_json, '$.inputIntent') = 'queued_turn'
    `;
    assert.deepEqual(
      rows.map((row) => row.turn_item_id),
      ["queued"],
    );
    const all = yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items`;
    assert.equal(all.length, 2);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
