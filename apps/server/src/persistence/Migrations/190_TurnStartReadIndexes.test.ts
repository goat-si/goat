import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("adds turn-start indexes when upgrading a database at migration 189", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 189 });
    const names = [
      "orchestration_v2_projection_messages_deferred_command_idx",
      "orchestration_v2_projection_subagents_routable_idx",
      "orchestration_v2_projection_context_transfers_fork_idx",
    ];
    const indexes = sql<{ readonly name: string }>`
      SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN ${sql.in(names)}`;
    assert.isEmpty(yield* indexes);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 190 }), [
      [190, "TurnStartReadIndexes"],
    ]);
    assert.sameMembers(
      (yield* indexes).map((index) => index.name),
      names,
    );
    assert.isEmpty(yield* runMigrations({ toMigrationInclusive: 190 }));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
