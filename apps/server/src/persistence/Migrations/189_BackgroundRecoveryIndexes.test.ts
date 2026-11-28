import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("adds the usage-limit index when upgrading a database at migration 188", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 188 });
    const indexName = "orchestration_v2_projection_turn_items_usage_limit_idx";
    assert.isEmpty(yield* sql`SELECT name FROM sqlite_schema WHERE name = ${indexName}`);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 189 }), [
      [189, "BackgroundRecoveryIndexes"],
    ]);
    const indexes = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ${indexName}`;
    assert.lengthOf(indexes, 1);
    assert.include(indexes[0]?.sql ?? "", "json_valid(payload_json)");
    assert.isEmpty(yield* runMigrations({ toMigrationInclusive: 189 }));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
