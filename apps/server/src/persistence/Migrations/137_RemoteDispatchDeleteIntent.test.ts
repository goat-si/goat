import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import RemoteDispatchDeleteIntentMigration from "./137_RemoteDispatchDeleteIntent.ts";

it.effect("adds delete intent columns and runs again over them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 136 });
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 137 }), [
      [137, "RemoteDispatchDeleteIntent"],
    ]);
    yield* RemoteDispatchDeleteIntentMigration;
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(remote_dispatches)`;
    const names = columns.map((column) => column.name);
    assert.isTrue(names.includes("delete_requested_at"));
    assert.isTrue(names.includes("delete_request_key"));
    assert.strictEqual(names.filter((name) => name === "delete_requested_at").length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
