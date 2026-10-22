import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/076_Memory.ts";
import { runMigrations } from "../persistence/Migrations.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
describe("Memory migration", () => {
  it.effect("upgrades a schema through ProjectionTurnItemRequestIndex without importing data", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 75 });
      yield* migration;
      yield* migration;
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_%'`;
      for (const name of [
        "memory_items",
        "memory_events",
        "memory_payloads",
        "memory_project_bindings",
        "memory_pending_forget_intents",
        "memory_identity_ledger",
        "memory_storage_samples",
      ])
        assert.isTrue(rows.some((row) => row.name === name));
    }).pipe(Effect.provide(database)),
  );
  it.effect("binding table constraints survive restart without copied provider data", () =>
    Effect.gen(function* () {
      yield* migration;
      const sql = yield* SqlClient.SqlClient;
      const bad = yield* Effect.exit(
        sql`INSERT INTO memory_project_bindings VALUES ('space','env','project',NULL,NULL,-1,0)`,
      );
      assert.isTrue(bad._tag === "Failure");
      yield* sql`INSERT INTO memory_project_bindings VALUES ('space','env','project',NULL,NULL,0,0)`;
      yield* migration;
      assert.strictEqual((yield* sql`SELECT * FROM memory_project_bindings`).length, 1);
      assert.strictEqual((yield* sql`SELECT * FROM memory_payloads`).length, 0);
    }).pipe(Effect.provide(database)),
  );
  it.effect("rolls back migration DDL with its transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql
        .withTransaction(Effect.andThen(migration, Effect.fail("barrier")))
        .pipe(Effect.exit);
      assert.strictEqual(
        (yield* sql`SELECT name FROM sqlite_master WHERE name='memory_events'`).length,
        0,
      );
    }).pipe(Effect.provide(database)),
  );
  it.effect("reruns Memory DDL idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migration;
      yield* sql`INSERT INTO memory_quota_counters VALUES ('fixture','live','user',3)`;
      yield* migration;
      assert.strictEqual(
        (yield* sql<{ value: number }>`SELECT value FROM memory_quota_counters`)[0]?.value,
        3,
      );
    }).pipe(Effect.provide(database)),
  );
  it.effect("keeps deletion metadata independent of thread deletion", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_tombstones (space,memory_id,delete_operation_id,deleting_environment_id,deleted_at,suppressed_source_keys_json,suppressed_content_json,source_exclusions_json) VALUES ('fixture','memory','op','env',0,'[]','[]','[]')`;
      yield* sql`DELETE FROM orchestration_v2_projection_threads`;
      assert.strictEqual((yield* sql`SELECT * FROM memory_tombstones`).length, 1);
    }).pipe(Effect.provide(database)),
  );
  it.effect("rejects invalid enum and duplicate keys", () =>
    Effect.gen(function* () {
      yield* migration;
      const sql = yield* SqlClient.SqlClient;
      assert.isTrue(
        (yield* Effect.exit(
          sql`INSERT INTO memory_outbox (id,space,kind,status,metadata_json,next_attempt_at) VALUES ('fixture','space','invalid','pending','{}',0)`,
        ))._tag === "Failure",
      );
      yield* sql`INSERT INTO memory_quota_counters VALUES ('space','live','scope',0)`;
      assert.isTrue(
        (yield* Effect.exit(
          sql`INSERT INTO memory_quota_counters VALUES ('space','live','scope',0)`,
        ))._tag === "Failure",
      );
    }).pipe(Effect.provide(database)),
  );
  it.effect("source SQLite FTS removes and rebuilds eligible rows", () =>
    Effect.gen(function* () {
      yield* migration;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_items_fts (rowid,body) VALUES (1,'synthetic searchable')`;
      assert.strictEqual(
        (yield* sql`SELECT rowid FROM memory_items_fts WHERE memory_items_fts MATCH 'synthetic'`)
          .length,
        1,
      );
      yield* sql`DELETE FROM memory_items_fts WHERE rowid=1`;
      yield* sql`INSERT INTO memory_items_fts (memory_items_fts) VALUES ('rebuild')`;
      assert.strictEqual(
        (yield* sql`SELECT rowid FROM memory_items_fts WHERE memory_items_fts MATCH 'synthetic'`)
          .length,
        0,
      );
    }).pipe(Effect.provide(database)),
  );
});
