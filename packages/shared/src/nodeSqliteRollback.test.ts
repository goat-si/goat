import { assert, it } from "@effect/vitest";
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
