import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("adds the provider-turn attempt index when upgrading migration 187", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 187 });
    const index = "orchestration_v2_projection_provider_turns_attempt_idx";
    assert.isEmpty(yield* sql`SELECT name FROM sqlite_schema WHERE name = ${index}`);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 188 }), [
      [188, "ProviderTurnAttemptIndex"],
    ]);
    assert.deepStrictEqual(yield* sql`SELECT name FROM sqlite_schema WHERE name = ${index}`, [
      { name: index },
    ]);
    assert.isEmpty(yield* runMigrations({ toMigrationInclusive: 188 }));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("records the migration when the provider-turn attempt index already exists", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 187 });
    yield* sql`CREATE INDEX orchestration_v2_projection_provider_turns_attempt_idx
      ON orchestration_v2_projection_provider_turns(run_attempt_id)`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 188 }), [
      [188, "ProviderTurnAttemptIndex"],
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
