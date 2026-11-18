// @effect-diagnostics nodeBuiltinImport:off -- inject a transient native rollback failure.
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqliteClient from "./nodeSqliteClient.ts";

it.effect(
  "a transaction SQLite already rolled back fails with its SqlError, which catch recovers",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE blobs (data BLOB)`;
      const [pages] = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
      yield* sql.unsafe(`PRAGMA max_page_count = ${(pages?.page_count ?? 1) + 3}`);
      // SQLITE_FULL rolls the transaction back inside SQLite, so the ROLLBACK after it finds none.
      const failure = yield* sql
        .withTransaction(sql`INSERT INTO blobs VALUES (zeroblob(1000000))`)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "SqlError");
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "keeps the typed failure and rolls back before another caller can use the connection",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries (value INTEGER)`;
      const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
      let failRollback = true;
      using _prepare = vi
        .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
        .mockImplementation(function (this: NodeSqlite.DatabaseSync, statement) {
          if (failRollback && statement === "ROLLBACK") throw new Error("rollback unavailable");
          return prepare.call(this, statement);
        });
      const failure = yield* sql
        .withTransaction(
          sql`INSERT INTO entries VALUES (1)`.pipe(Effect.andThen(Effect.fail("body failed"))),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure, "body failed");
      const refused = yield* sql`INSERT INTO entries VALUES (2)`.pipe(Effect.flip);
      assert.strictEqual(refused._tag, "SqlError");
      failRollback = false;
      yield* sql`INSERT INTO entries VALUES (3)`;
      assert.deepStrictEqual(yield* sql`SELECT value FROM entries`.values, [[3]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);
