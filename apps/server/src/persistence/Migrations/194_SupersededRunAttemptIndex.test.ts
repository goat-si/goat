import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("indexes superseded attempts when upgrading from migration 193", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 193 });
    const name = "orchestration_v2_projection_run_attempts_superseded_idx";
    assert.isEmpty(yield* sql`SELECT name FROM sqlite_schema WHERE name = ${name}`);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 194 }), [
      [194, "SupersededRunAttemptIndex"],
    ]);
    const plan = yield* sql<{
      readonly detail: string;
    }>`EXPLAIN QUERY PLAN SELECT run_id, root_node_id FROM orchestration_v2_projection_run_attempts WHERE thread_id = 'thread' AND status = 'superseded'`;
    assert.isTrue(plan.some((row) => row.detail.includes(name)));
    assert.isEmpty(yield* runMigrations({ toMigrationInclusive: 194 }));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
