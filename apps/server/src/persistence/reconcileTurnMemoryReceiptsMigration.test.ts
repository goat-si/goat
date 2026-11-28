import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const readLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
  return rows.map(({ migration_id, name }) => [migration_id, name] as const);
});
const readReceipts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM turn_memory_receipts ORDER BY id`;
});

it.effect("appends turn receipts to an up-to-date dev ledger", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 184 });
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 185 }), [
      [185, "TurnMemoryReceipts"],
    ]);
    yield* runMigrations();
    assert.deepStrictEqual(yield* readLedger, migrationManifest);
    assert.deepStrictEqual(yield* readReceipts, []);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
