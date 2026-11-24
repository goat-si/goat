import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest, runMigrations } from "../Migrations.ts";

it.effect("adds the worktree path index when upgrading from the preceding migration", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const migrationId = migrationManifest.find(([, name]) => name === "WorktreePathKeyIndex")?.[0];
    assert.isDefined(migrationId);
    yield* runMigrations({ toMigrationInclusive: migrationId - 1 });
    const names = ["orchestration_v2_projection_threads_worktree_path_key_idx"];
    const indexes = sql<{ readonly name: string }>`
      SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN ${sql.in(names)}`;
    assert.isEmpty(yield* indexes);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: migrationId }), [
      [migrationId, "WorktreePathKeyIndex"],
    ]);
    assert.sameMembers(
      (yield* indexes).map((index) => index.name),
      names,
    );
    assert.isEmpty(yield* runMigrations({ toMigrationInclusive: migrationId }));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
