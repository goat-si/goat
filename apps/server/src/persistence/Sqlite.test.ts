// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import { migrationManifest } from "./Migrations.ts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "./Sqlite.ts";

it.effect("drops planner statistics a database already has", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      // A connection still using the old stats scans the table at each step.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("runs file database opening and migration SQL away from the server thread", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-writer-migration-" });
    const dbPath = path.join(directory, "state.sqlite");
    let nativeCalls = 0;
    using _prepare = vi
      .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
      .mockImplementation(() => {
        nativeCalls++;
        throw new Error("Main-thread SQLite must not run in worker persistence mode");
      });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const applied = yield* sql<{ migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1`;
      assert.isAbove(migrationManifest.length, 0);
      const migrationHead = Math.max(...migrationManifest.map(([id]) => id));
      assert.equal(applied[0]?.migration_id, migrationHead);
      yield* sql`CREATE TABLE writer_roundtrip(value TEXT)`;
      yield* sql`INSERT INTO writer_roundtrip VALUES ('kept')`;
      assert.deepEqual(yield* sql`SELECT value FROM writer_roundtrip`, [{ value: "kept" }]);
    }).pipe(Effect.provide(SqlitePersistence.layerFromPath(dbPath)));
    assert.equal(nativeCalls, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

import * as NodeWorkerThreads from "node:worker_threads";

it.effect("does not receipt a failed worker migration and reopens safely", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-failed-migration-" });
    const filename = path.join(directory, "state.sqlite");
    const receipts = () => {
      const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
      try {
        if (
          db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'effect_sql_migrations'").get() ===
          undefined
        )
          return undefined;
        return Number(
          db.prepare("SELECT COUNT(*) AS count FROM effect_sql_migrations").get()?.count,
        );
      } finally {
        db.close();
      }
    };
    let before: number | undefined;
    const original = NodeWorkerThreads.Worker.prototype.postMessage;
    using injecting = vi
      .spyOn(NodeWorkerThreads.Worker.prototype, "postMessage")
      .mockImplementation(function (this: NodeWorkerThreads.Worker, message, ...rest) {
        if (
          before === undefined &&
          typeof message === "object" &&
          message !== null &&
          "sql" in message &&
          typeof message.sql === "string" &&
          /^\s*CREATE\s+TABLE\b/i.test(message.sql) &&
          !message.sql.includes("effect_sql_migrations")
        ) {
          before = receipts();
          if (before !== undefined)
            return original.call(
              this,
              { ...message, sql: "SELECT deliberately_missing_migration_function()" },
              ...rest,
            );
        }
        return original.call(this, message, ...rest);
      });
    const failed = yield* Layer.build(SqlitePersistence.layerFromPath(filename)).pipe(
      Effect.scoped,
      Effect.exit,
    );
    assert.equal(failed._tag, "Failure");
    assert.isNumber(before);
    assert.equal(receipts(), before);
    injecting.mockRestore();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`)[0]?.id,
        Math.max(...migrationManifest.map(([id]) => id)),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerFromPath(filename)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
