import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import RemoteDispatchObservationMigration from "./094_RemoteDispatchObservation.ts";

it.effect("runs again over its own column, as a relocated migration id would", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* RemoteDispatchObservationMigration;
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(remote_dispatches)`;
    assert.strictEqual(columns.filter((column) => column.name === "observation").length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
