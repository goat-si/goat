import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationLedgerProblem, readMigrationSnapshot } from "./migrationPreflight.ts";
import {
  hasPendingMigrations,
  migrationEntries,
  migrationManifest,
  runMigrations,
} from "./Migrations.ts";
import TurnMemoryReceipts from "./Migrations/185_TurnMemoryReceipts.ts";
import { canonicalMigrationName, skippedV2Migrations } from "./reconcileGoatMigrationIds.ts";

const seedReceiptPreview = Effect.fn("seedReceiptPreview")(function* (
  throughId: 177 | 181 | 183 = 177,
) {
  const id = throughId === 177 ? 178 : 184;
  yield* runMigrations({ toMigrationInclusive: throughId });
  yield* TurnMemoryReceipts;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
    VALUES (${id}, 'TurnMemoryReceipts', '2000-01-01 00:00:00')`;
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

const readReceiptObjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM sqlite_schema WHERE name IN
    ('turn_memory_receipts', 'turn_memory_by_run', 'turn_memory_delete_thread') ORDER BY name`;
});

it.effect.each([177, 181, 183] as const)(
  "upgrades the receipt preview based on %s without losing data on reopen",
  (throughId) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-turn-receipt-upgrade-" });
      const filename = path.join(directory, "state.sqlite");
      const database = NodeSqliteClient.layer({ filename });
      const before = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedReceiptPreview(throughId);
        yield* sql`UPDATE effect_sql_migrations SET name = 'ChannelLedgerRequiresWorkTriggerAuthority'
        WHERE name = 'ChannelLedger'`;
        return { receipts: yield* readReceipts, objects: yield* readReceiptObjects };
      }).pipe(Effect.provide(database));
      const snapshot = readMigrationSnapshot(filename);
      assert.isNotNull(snapshot);
      if (snapshot === null) return;
      assert.isUndefined(migrationLedgerProblem(snapshot, "test"));
      assert.isTrue(yield* hasPendingMigrations().pipe(Effect.provide(database)));
      const expected = migrationManifest.filter(([id]) => id > throughId && id < 185);
      assert.deepStrictEqual(yield* runMigrations().pipe(Effect.provide(database)), expected);
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
        const conversations = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(channel_conversations)`;
        const inbox = yield* sql<{ readonly name: string }>`PRAGMA table_info(channel_inbox)`;
        assert.include(
          conversations.map(({ name }) => name),
          "slack_bot_id",
        );
        assert.include(
          inbox.map(({ name }) => name),
          "auth_session_id",
        );
        const dispatches = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(remote_dispatches)`;
        assert.include(
          dispatches.map(({ name }) => name),
          "remote_environment_id",
        );
        assert.deepStrictEqual(yield* readReceipts, before.receipts);
        assert.deepStrictEqual(yield* readReceiptObjects, before.objects);
        assert.deepStrictEqual(
          yield* sql`SELECT migration_id, created_at FROM effect_sql_migrations
          WHERE name = 'TurnMemoryReceipts'`,
          [{ migration_id: 185, created_at: "2000-01-01 00:00:00" }],
        );
        const previousPreviewEntries = migrationEntries.flatMap(([id, name, migration]) =>
          id === 184 ? [] : [[id === 185 ? 184 : id, name, migration] as const],
        );
        assert.include(
          skippedV2Migrations(
            previousPreviewEntries,
            ledger.map(([migration_id, name]) => ({ migration_id, name })),
            185,
          )?.message,
          "184_TurnMemoryReceipts (recorded: RemoteDispatchEnvironment)",
        );
        assert.isFalse(yield* hasPendingMigrations());
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(database));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("appends turn receipts to an up-to-date dev ledger", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 184 });
    assert.deepStrictEqual(yield* runMigrations(), [[185, "TurnMemoryReceipts"]]);
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
      yield* seedReceiptPreview();
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

it.effect(
  "rolls back the first two migrations and marker move if the last migration cannot run",
  () =>
    Effect.gen(function* () {
      yield* seedReceiptPreview(181);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE remote_dispatches RENAME TO incomplete_remote_dispatches`;
      const before = yield* readLedger;
      const schema = yield* sql`SELECT * FROM sqlite_schema ORDER BY type, name`;
      const receipts = yield* readReceipts;
      assert.include(
        (yield* Effect.flip(runMigrations())).message,
        "184_RemoteDispatchEnvironment",
      );
      assert.deepStrictEqual(yield* readLedger, before);
      assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_schema ORDER BY type, name`, schema);
      assert.deepStrictEqual(yield* readReceipts, receipts);
      assert.isTrue(yield* hasPendingMigrations());
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("does not use the receipt preview exception for a partial late gap", () =>
  Effect.gen(function* () {
    yield* seedReceiptPreview(181);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (182, 'SlackConversationBot')`;
    const before = yield* readLedger;
    const schema = yield* sql`SELECT * FROM sqlite_schema ORDER BY type, name`;
    const snapshot = {
      history: before.map(([migration_id, name]) => ({ migration_id, name })),
      hasMemoryTables: true,
    };
    assert.include(
      migrationLedgerProblem(snapshot, "test"),
      "Unreleased memory DB is incompatible",
    );
    assert.include(
      (yield* Effect.flip(runMigrations())).message,
      "Unreleased memory DB is incompatible",
    );
    assert.deepStrictEqual(yield* readLedger, before);
    assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_schema ORDER BY type, name`, schema);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("refuses an exact receipt preview ledger when a receipt object is absent", () =>
  Effect.gen(function* () {
    yield* seedReceiptPreview(183);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TRIGGER turn_memory_delete_thread`;
    const before = yield* readLedger;
    const schema = yield* sql`SELECT * FROM sqlite_schema ORDER BY type, name`;
    const receipts = yield* readReceipts;
    assert.include(
      (yield* Effect.flip(runMigrations())).message,
      "missing its table, index, or trigger",
    );
    assert.deepStrictEqual(yield* readLedger, before);
    assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_schema ORDER BY type, name`, schema);
    assert.deepStrictEqual(yield* readReceipts, receipts);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
