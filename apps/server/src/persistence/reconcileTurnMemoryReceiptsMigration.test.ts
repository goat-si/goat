import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationLedgerProblem, readMigrationSnapshot } from "./migrationPreflight.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import TurnMemoryReceipts from "./Migrations/184_TurnMemoryReceipts.ts";
import { canonicalMigrationName } from "./reconcileGoatMigrationIds.ts";

const seedReceiptPreview = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 177 });
  yield* TurnMemoryReceipts;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES (178, 'TurnMemoryReceipts')`;
  yield* sql`INSERT INTO turn_memory_receipts
    (id, thread_id, run_id, space, kind, query_digest, refs_json)
    VALUES (7, 'preview-thread', 'preview-run', 'preview-space', 'recall', 'digest', '[]')`;
});

const readReceipts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM turn_memory_receipts ORDER BY id`;
});

const readLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map(({ migration_id, name }) => [migration_id, name] as const);
});

it.effect("upgrades a receipt preview and preserves its data on reopen", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-turn-receipt-upgrade-" });
    const filename = path.join(directory, "state.sqlite");
    const database = NodeSqliteClient.layer({ filename });
    const receipts = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedReceiptPreview;
      yield* sql`UPDATE effect_sql_migrations SET name = 'ChannelLedgerRequiresWorkTriggerAuthority'
        WHERE name = 'ChannelLedger'`;
      return yield* readReceipts;
    }).pipe(Effect.provide(database));
    const snapshot = readMigrationSnapshot(filename);
    assert.isNotNull(snapshot);
    if (snapshot === null) return;
    assert.isUndefined(migrationLedgerProblem(snapshot, "test"));
    assert.deepStrictEqual(yield* runMigrations().pipe(Effect.provide(database)), [
      [178, "WebhookDeliveryFiringEvidence"],
      [179, "ChannelWorkerGenerations"],
      [180, "ChannelBotTaskSnooze"],
      [181, "ChannelBotAttention"],
    ]);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ledger = yield* readLedger;
      assert.deepStrictEqual(
        ledger.map(([id, name]) => [id, canonicalMigrationName(name)] as const),
        migrationManifest,
      );
      assert.include(
        ledger.map(([, name]) => name),
        "ChannelLedgerRequiresWorkerReleaseAuthority",
      );
      const schema = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_schema WHERE name IN (
          'scheduled_task_webhook_firings', 'channel_worker_generations',
          'channel_task_status_version', 'channel_bot_attention',
          'turn_memory_by_run', 'turn_memory_delete_thread'
        ) ORDER BY name`;
      assert.deepStrictEqual(
        schema.map(({ name }) => name),
        [
          "channel_bot_attention",
          "channel_task_status_version",
          "channel_worker_generations",
          "scheduled_task_webhook_firings",
          "turn_memory_by_run",
          "turn_memory_delete_thread",
        ],
      );
      assert.deepStrictEqual(yield* readReceipts, receipts);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(database));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("appends turn receipts to an up-to-date dev ledger", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 181 });
    assert.deepStrictEqual(yield* runMigrations(), [[184, "TurnMemoryReceipts"]]);
    assert.deepStrictEqual(yield* readLedger, migrationManifest);
    assert.deepStrictEqual(yield* readReceipts, []);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each(["missing earlier row", "mixed newer tail"] as const)(
  "refuses an incompatible receipt preview without writes: %s",
  (mismatch) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedReceiptPreview;
      if (mismatch === "missing earlier row") {
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 176`;
      } else {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (179, 'ChannelWorkerGenerations')`;
      }
      const before = yield* readLedger;
      const receipts = yield* readReceipts;
      const schema = yield* sql`SELECT * FROM sqlite_schema ORDER BY type, name`;
      const problem = migrationLedgerProblem(
        {
          history: before.map(([migration_id, name]) => ({ migration_id, name })),
          hasMemoryTables: true,
        },
        "test",
      );
      assert.include(problem, "Unreleased memory DB is incompatible");
      const failure = yield* Effect.flip(runMigrations());
      assert.include(failure.message, "Unreleased memory DB is incompatible");
      assert.deepStrictEqual(yield* readLedger, before);
      assert.deepStrictEqual(yield* readReceipts, receipts);
      assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_schema ORDER BY type, name`, schema);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
