import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades existing databases with snapshot and single-row preview tables", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 132 });
    assert.deepStrictEqual(yield* runMigrations(), [[133, "WorktreeSnapshots"]]);
    const tables = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE name IN ('worktree_snapshots', 'worktree_cleanup_preview') ORDER BY name`;
    assert.deepStrictEqual(
      tables.map((row) => row.name),
      ["worktree_cleanup_preview", "worktree_snapshots"],
    );
    yield* sql`INSERT INTO worktree_cleanup_preview (preview_id, started_at, planned_count) VALUES ('one', 1, 0)`;
    const duplicate = yield* Effect.exit(
      sql`INSERT INTO worktree_cleanup_preview (preview_id, started_at, planned_count) VALUES ('two', 1, 0)`,
    );
    assert.equal(duplicate._tag, "Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
