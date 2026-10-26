import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import RemoteDispatchQuestionsMigration from "./074_RemoteDispatchQuestions.ts";

it.effect("runs again over its own column, as a relocated migration id would", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* RemoteDispatchQuestionsMigration;
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(remote_dispatches)`;
    assert.strictEqual(columns.filter((column) => column.name === "pending_request_ids").length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
