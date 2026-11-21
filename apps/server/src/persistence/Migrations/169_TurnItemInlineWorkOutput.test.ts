import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import { isInlineWorkOutput } from "../../orchestration-v2/turnItemProjectionPayload.ts";

it.effect("backfills inline outputs using GOAT and legacy markers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 168 });
    const rows = [
      ["goat", "dynamic_tool", '{"goatMcpApp":{}}', 1],
      ["legacy", "dynamic_tool", '{"t3McpApp":{}}', 1],
      ["html", "dynamic_tool", '{"htmlRender":{}}', 1],
      ["image", "dynamic_tool", '{"viewedImagePath":"/image.png"}', 1],
      ["delegate", "dynamic_tool", '{"toolName":"mcp__goat__delegate_task"}', 1],
      ["sent", "dynamic_tool", '{"other":1,"persistentSentMessage":true}', 1],
      ["plain", "dynamic_tool", '{"toolName":"plain"}', 0],
      ["other", "command_execution", '{"htmlRender":{}}', 0],
    ] as const;
    for (const [id, type, payload] of rows) {
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
        VALUES (${id}, 'thread', 'run', 0, ${type}, 'completed', '2026-01-01', ${payload})`;
    }
    yield* runMigrations();
    for (const [, type, payload, expected] of rows) {
      assert.equal(type === "dynamic_tool" && isInlineWorkOutput(payload) ? 1 : 0, expected);
    }
    const bounded = yield* sql<{ readonly turn_item_id: string }>`
      SELECT item.turn_item_id FROM orchestration_v2_projection_turn_items AS item
      WHERE item.thread_id = 'thread' AND item.run_id = 'run'
        AND item.status = 'completed' AND item.inline_work_output = 1`;
    assert.deepEqual(
      new Set(bounded.map((row) => row.turn_item_id)),
      new Set(rows.filter(([, , , expected]) => expected === 1).map(([id]) => id)),
    );
    const actual = yield* sql<{
      readonly turn_item_id: string;
      readonly inline_work_output: number;
    }>`
      SELECT turn_item_id, inline_work_output FROM orchestration_v2_projection_turn_items`;
    assert.deepEqual(
      new Map(actual.map((row) => [row.turn_item_id, row.inline_work_output])),
      new Map(rows.map(([id, , , expected]) => [id, expected])),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
