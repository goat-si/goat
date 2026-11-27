import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest, runMigrations } from "../Migrations.ts";

it.effect("rebuilds the deferred command index on upgrade from the preceding migration", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const migrationId = migrationManifest.find(
      ([, name]) => name === "DeferredSlashCommandIndex",
    )?.[0];
    assert.isDefined(migrationId);
    yield* runMigrations({ toMigrationInclusive: migrationId - 1 });
    yield* sql`DROP INDEX orchestration_v2_projection_messages_deferred_command_idx`;
    yield* sql`CREATE INDEX orchestration_v2_projection_messages_deferred_command_idx ON orchestration_v2_projection_messages(thread_id) WHERE role = 'user'`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: migrationId }), [
      [migrationId, "DeferredSlashCommandIndex"],
    ]);
    const rows = yield* sql<{
      readonly sql: string;
    }>`SELECT sql FROM sqlite_schema WHERE name = 'orchestration_v2_projection_messages_deferred_command_idx'`;
    assert.include(rows[0]?.sql, "GLOB '/*'");
    assert.isEmpty(yield* runMigrations({ toMigrationInclusive: migrationId }));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
