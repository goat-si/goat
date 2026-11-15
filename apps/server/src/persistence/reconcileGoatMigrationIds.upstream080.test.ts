import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  hasPendingMigrations,
  migrationEntries,
  migrationManifest,
  runMigrations,
} from "./Migrations.ts";
import { GOAT_MIGRATION_NAMES, reconcileGoatMigrationIds } from "./reconcileGoatMigrationIds.ts";
import {
  currentRow,
  goatNames,
  history,
  isDatabaseNewerThanBuildError,
  schema,
  seedOldGoatLedger,
  seedUserData,
  UPSTREAM_80S,
  userData,
} from "./reconcileGoatMigrationIds.testkit.ts";

describe("GOAT migrations after upstream 080-089", () => {
  it.effect("a new database records upstream 080-089 in place and GOAT's block from 90", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      assert.deepStrictEqual(
        migrationManifest.filter(([id]) => id >= 80 && id <= 89),
        UPSTREAM_80S,
      );
      assert.isTrue(goatNames.every((name) => currentRow(name)[0] >= 90));
      assert.deepStrictEqual(currentRow("ServerActivityIndexes"), [90, "ServerActivityIndexes"]);
      assert.deepStrictEqual(migrationManifest.at(-1), [157, "DisposableMachineEnrollment"]);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([146, 147] as const)(
    "a ledger at GOAT's old max %i upgrades, keeps its data and records GOAT names at 90+",
    (oldMax) =>
      Effect.gen(function* () {
        yield* seedOldGoatLedger(oldMax);
        yield* seedUserData;
        const before = yield* userData;
        assert.deepStrictEqual((yield* history).at(-1), [oldMax, goatNames[oldMax - 80]!]);
        assert.deepStrictEqual(yield* runMigrations(), [
          ...UPSTREAM_80S,
          ...goatNames.slice(oldMax - 79).map(currentRow),
        ]);
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.includeDeepMembers(yield* history, [
          [90, "ServerActivityIndexes"],
          [156, "DisposableMachineRequests"],
          [157, "DisposableMachineEnrollment"],
        ]);
        assert.deepStrictEqual(yield* userData, before);
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("a database at the current max reopens without running or moving anything", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const before = yield* schema;
      assert.deepStrictEqual(yield* reconcileGoatMigrationIds(migrationEntries), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* schema, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("an upgrade stopped after reconciliation resumes with the remaining migrations", () =>
    Effect.gen(function* () {
      yield* seedOldGoatLedger(146);
      assert.deepStrictEqual(yield* reconcileGoatMigrationIds(migrationEntries), UPSTREAM_80S);
      assert.deepStrictEqual(yield* runMigrations(), [currentRow("DisposableMachineEnrollment")]);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses a newer build's migration on an id GOAT moves to, and changes nothing", () =>
    Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (150, 'FutureMigration')`;
      const before = yield* history;
      const tables = yield* schema;
      const exit = yield* Effect.exit(runMigrations());
      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag !== "Failure") return;
      const failure = Cause.squash(exit.cause);
      assert.isTrue(isDatabaseNewerThanBuildError(failure));
      if (!isDatabaseNewerThanBuildError(failure)) return;
      assert.deepStrictEqual(failure.unknownMigrations, ["FutureMigration"]);
      assert.strictEqual(
        failure.originalMessage,
        "Cannot move GOAT migrations onto ids another migration recorded.",
      );
      assert.deepStrictEqual(yield* history, before);
      assert.deepStrictEqual(yield* schema, tables);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses a ledger whose upstream row is recorded under another name", () =>
    Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE effect_sql_migrations SET name = 'ActiveTurnItemIndexes' WHERE migration_id = 79`;
      const before = yield* history;
      const failure = yield* Effect.flip(runMigrations());
      assert.strictEqual(failure._tag, "MigrationError");
      if (failure._tag !== "MigrationError") return;
      assert.strictEqual(failure.kind, "BadState");
      assert.strictEqual(
        failure.message,
        "Migration 79 is recorded as ActiveTurnItemIndexes, expected DelegatedRecoveryIndexes.",
      );
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "the previous build refuses a database this build migrated and leaves it unchanged",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const before = yield* history;
        const tables = yield* schema;
        // The previous build's manifest: no upstream 080-089, GOAT ten ids lower.
        const upstream80s = new Set(UPSTREAM_80S.map(([, name]) => name));
        const previousEntries = migrationEntries.flatMap(([id, name, migration]) =>
          upstream80s.has(name)
            ? []
            : [[GOAT_MIGRATION_NAMES.has(name) ? id - 10 : id, name, migration] as const],
        );
        const failure = yield* Effect.flip(reconcileGoatMigrationIds(previousEntries));
        assert.strictEqual(failure._tag, "MigrationError");
        if (failure._tag === "MigrationError") {
          assert.strictEqual(failure.kind, "BadState");
          assert.strictEqual(
            failure.message,
            "Cannot move GOAT migrations onto ids another migration recorded.",
          );
        }
        assert.deepStrictEqual(yield* history, before);
        assert.deepStrictEqual(yield* schema, tables);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("an upgrade interrupted in the last upstream step rolls back whole and resumes", () =>
    Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      yield* seedUserData;
      const sql = yield* SqlClient.SqlClient;
      const before = yield* history;
      const tables = yield* schema;
      const data = yield* userData;
      const [lastId] = UPSTREAM_80S.at(-1)!;
      const failing = migrationEntries.map((entry) =>
        entry[0] === lastId
          ? ([entry[0], entry[1], sql`SELECT * FROM missing_migration_fixture`] as const)
          : entry,
      );
      const failure = yield* Effect.flip(reconcileGoatMigrationIds(failing));
      assert.strictEqual(failure._tag, "MigrationError");
      assert.deepStrictEqual(yield* history, before);
      assert.deepStrictEqual(yield* schema, tables);
      assert.deepStrictEqual(yield* runMigrations(), UPSTREAM_80S);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* userData, data);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upstream 080-089 accept schema that is already present", () =>
    Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      for (const [id, , migration] of migrationEntries) {
        if (id >= 80 && id <= 89) yield* migration;
      }
      assert.deepStrictEqual(yield* runMigrations(), UPSTREAM_80S);
      assert.deepStrictEqual(yield* history, migrationManifest);
      const before = yield* schema;
      for (const [id, , migration] of migrationEntries) {
        if (id >= 80 && id <= 89) yield* migration;
      }
      assert.deepStrictEqual(yield* schema, before);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("080 keeps a task's thread on upgrade and a rerun keeps its chosen mode", () =>
    Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      yield* seedUserData;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const mode = sql`SELECT task_id, thread_mode FROM scheduled_tasks`;
      assert.deepStrictEqual(yield* mode, [{ task_id: "task", thread_mode: "continue" }]);
      yield* sql`UPDATE scheduled_tasks SET thread_mode = 'new_thread'`;
      yield* migrationEntries.find(([id]) => id === 80)![2];
      assert.deepStrictEqual(yield* mode, [{ task_id: "task", thread_mode: "new_thread" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
describe("hasPendingMigrations", () => {
  it.effect("a fresh database is pending, and nothing is once it migrated", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* hasPendingMigrations());
      yield* runMigrations();
      assert.isFalse(yield* hasPendingMigrations());
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("a ledger from before GOAT's id shift (max 147) is pending until it upgrades", () =>
    Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      assert.deepStrictEqual((yield* history).at(-1)?.[0], 147);
      assert.isTrue(yield* hasPendingMigrations());
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isFalse(yield* hasPendingMigrations());
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "GOAT rows recorded above their ids are pending although the newest id is past this build's",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        // Negate first so no row collides with another while the block moves up by ten.
        yield* sql`UPDATE effect_sql_migrations SET migration_id = -migration_id WHERE name IN ${sql.in(goatNames)}`;
        yield* sql`UPDATE effect_sql_migrations SET migration_id = 10 - migration_id WHERE migration_id < 0`;
        assert.deepStrictEqual((yield* history).at(-1), [167, "DisposableMachineEnrollment"]);
        assert.isTrue(yield* hasPendingMigrations());
        // reconcileGoatMigrationIds moves them back: a write the CLI must not make under a server.
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.isFalse(yield* hasPendingMigrations());
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
