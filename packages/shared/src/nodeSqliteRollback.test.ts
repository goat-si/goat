// @effect-diagnostics nodeBuiltinImport:off -- inject a transient native rollback failure.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqliteClient from "./nodeSqliteClient.ts";

it.effect.each([false, true])(
  "a rejected COMMIT isolates the next lease (writer worker: %s)",
  (writerWorker) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-commit-" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`;
        yield* sql`CREATE TABLE child (
        parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED
      )`;
        const failure = yield* sql
          .withTransaction(sql`INSERT INTO child VALUES (7)`)
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SqlError");
        assert.deepStrictEqual(yield* sql`SELECT parent_id FROM child`.values, []);
        yield* sql.withTransaction(
          sql`INSERT INTO parent VALUES (8)`.pipe(
            Effect.andThen(sql`INSERT INTO child VALUES (8)`),
          ),
        );
        assert.deepStrictEqual(yield* sql`SELECT parent_id FROM child`.values, [[8]]);
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: path.join(dir, "db.sqlite"), writerWorker })),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the COMMIT failure typed and quarantines when cleanup also fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE entries (value INTEGER)`;
    const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
    let blockRollback = true;
    let blockCommit = true;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.DatabaseSync.prototype, "prepare").mockImplementation(function (
          this: NodeSqlite.DatabaseSync,
          statement,
        ) {
          if (blockCommit && statement === "COMMIT") throw new Error("injected commit failure");
          if (blockRollback && statement === "ROLLBACK")
            throw new Error("injected rollback failure");
          return prepare.call(this, statement);
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const failure = yield* sql
      .withTransaction(sql`INSERT INTO entries VALUES (1)`)
      .pipe(Effect.flip);
    assert.match(String(failure.reason.cause), /injected commit failure/);
    const refused = yield* sql`SELECT value FROM entries`.pipe(Effect.flip);
    assert.match(String(refused.reason.cause), /injected rollback failure/);
    blockCommit = false;
    blockRollback = false;
    yield* sql.withTransaction(sql`INSERT INTO entries VALUES (2)`);
    assert.deepStrictEqual(yield* sql`SELECT value FROM entries`.values, [[2]]);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

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
