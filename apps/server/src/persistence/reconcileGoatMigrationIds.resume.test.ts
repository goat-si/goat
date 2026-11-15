// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { hasPendingMigrations, migrationEntries, runMigrations } from "./Migrations.ts";
import { GOAT_MIGRATION_NAMES, reconcileGoatMigrationIds } from "./reconcileGoatMigrationIds.ts";
import {
  currentRow,
  fresh,
  goatNames,
  history,
  isDatabaseNewerThanBuildError,
  schema,
  seedOldGoatLedger,
  seedUserData,
  snapshot,
  UPSTREAM_80S,
  userData,
} from "./reconcileGoatMigrationIds.testkit.ts";

/** A database per test: an in-memory one, or a file that a restart reopens on a new connection. */
const databases = [
  ["in-memory", () => ({ open: NodeSqliteClient.layer({ filename: ":memory:" }), reopen: null })],
  [
    "file",
    () => {
      const filename = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-shift-resume-")),
        "state.sqlite",
      );
      return { open: NodeSqliteClient.layer({ filename }), reopen: filename };
    },
  ],
] as const;

/** Runs `restart` on the same database: a new connection for a file, the same one in memory. */
const onRestart = <A, E>(
  reopen: string | null,
  restart: Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  reopen === null
    ? restart
    : restart.pipe(Effect.provide(NodeSqliteClient.layer({ filename: reopen })));

/** The build before cycle 261114: no upstream 080-089, GOAT ten ids lower. */
const upstream80Names = new Set(UPSTREAM_80S.map(([, name]) => name));
const previousEntries = migrationEntries.flatMap(([id, name, migration]) =>
  upstream80Names.has(name)
    ? []
    : [[GOAT_MIGRATION_NAMES.has(name) ? id - 10 : id, name, migration] as const],
);
const previousNames = new Set<string>(previousEntries.map(([, name]) => name));

/** What the previous build does on this database: refuse, name what it does not know, write nothing. */
const previousBuildRefuses = Effect.gen(function* () {
  const before = yield* history;
  const tables = yield* schema;
  const failure = yield* Effect.flip(reconcileGoatMigrationIds(previousEntries));
  assert.strictEqual(failure._tag, "MigrationError");
  // Unknown names turn that MigrationError into DatabaseNewerThanBuildError (exit 79).
  assert.isNotEmpty(before.filter(([, name]) => !previousNames.has(name)));
  assert.deepStrictEqual(yield* history, before);
  assert.deepStrictEqual(yield* schema, tables);
});

/** Stands in for a kill: the step that records `name` in the ledger fails and rolls back. */
const killWhenRecording = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`CREATE TRIGGER test_kill_insert BEFORE INSERT ON effect_sql_migrations
      WHEN new.name = '${name}' BEGIN SELECT RAISE(ABORT, 'killed'); END`);
    yield* sql.unsafe(`CREATE TRIGGER test_kill_update BEFORE UPDATE ON effect_sql_migrations
      WHEN new.name = '${name}' BEGIN SELECT RAISE(ABORT, 'killed'); END`);
  });
const reviveAfterKill = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER test_kill_insert`;
  yield* sql`DROP TRIGGER test_kill_update`;
});

const recordedUpstream80s = Effect.map(history, (rows) =>
  rows.filter(([, name]) => upstream80Names.has(name)),
);
const goatRows = Effect.map(history, (rows) =>
  rows.filter(([, name]) => GOAT_MIGRATION_NAMES.has(name)),
);

/** GOAT's rows at their current ids and upstream 080-089 unrecorded: the ledger move alone. */
const seedMovedLedgerOnly = Effect.gen(function* () {
  yield* seedOldGoatLedger(147);
  const sql = yield* SqlClient.SqlClient;
  const goat = sql.in([...GOAT_MIGRATION_NAMES]);
  yield* sql`UPDATE effect_sql_migrations SET migration_id = -migration_id WHERE name IN ${goat}`;
  yield* sql`UPDATE effect_sql_migrations SET migration_id = 10 - migration_id WHERE migration_id < 0`;
});

describe.each(databases)("the GOAT id shift on a %s database", (_kind, database) => {
  it.effect.each([
    ["fresh", Effect.void],
    ["at old max 147", seedOldGoatLedger(147)],
    ["at old max 140", seedOldGoatLedger(140)],
    ["at old max 85", seedOldGoatLedger(85)],
    ["at old max 79", seedOldGoatLedger(79)],
    ["a T3 ledger 1-89", runMigrations({ toMigrationInclusive: 89 })],
    [
      "at old max 147 with upstream 080-089 bodies already applied",
      Effect.gen(function* () {
        yield* seedOldGoatLedger(147);
        for (const [id, , migration] of migrationEntries) {
          if (id >= 80 && id <= 89) yield* migration;
        }
      }),
    ],
    ["with GOAT's rows moved and upstream 080-089 unrecorded", seedMovedLedgerOnly],
  ] as const)("upgrades a database %s to what a fresh database records", ([, seed]) => {
    const { open, reopen } = database();
    return Effect.gen(function* () {
      yield* seed;
      assert.isTrue(yield* hasPendingMigrations());
      yield* onRestart(reopen, runMigrations());
      assert.deepStrictEqual(yield* onRestart(reopen, snapshot), yield* fresh);
      assert.deepStrictEqual(yield* onRestart(reopen, runMigrations()), []);
      assert.isFalse(yield* onRestart(reopen, hasPendingMigrations()));
    }).pipe(Effect.provide(open));
  });

  it.effect("refuses a T3 ledger with a newer row at 90 and leaves it unchanged", () => {
    const { open } = database();
    return Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 89 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (90, 'NewerUpstream')`;
      const before = yield* history;
      const tables = yield* schema;
      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(
        exit._tag === "Failure" && isDatabaseNewerThanBuildError(Cause.squash(exit.cause)),
      );
      assert.deepStrictEqual(yield* history, before);
      assert.deepStrictEqual(yield* schema, tables);
    }).pipe(Effect.provide(open));
  });

  it.effect("a kill inside the ledger move leaves the old ledger whole", () => {
    const { open, reopen } = database();
    return Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      const before = yield* history;
      yield* killWhenRecording(goatNames.at(-1) ?? "");
      assert.isTrue((yield* Effect.exit(runMigrations()))._tag === "Failure");
      assert.deepStrictEqual(yield* history, before);
      yield* reviveAfterKill;
      yield* onRestart(reopen, runMigrations());
      assert.deepStrictEqual(yield* onRestart(reopen, snapshot), yield* fresh);
    }).pipe(Effect.provide(open));
  });

  it.effect("a kill after the ledger move keeps the move with 080 and resumes with 081", () => {
    const { open, reopen } = database();
    return Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      yield* seedUserData;
      const data = yield* userData;
      yield* killWhenRecording("ProjectionMessageSearchText");
      assert.isTrue((yield* Effect.exit(runMigrations()))._tag === "Failure");
      assert.deepStrictEqual(yield* goatRows, goatNames.map(currentRow));
      assert.deepStrictEqual(yield* recordedUpstream80s, UPSTREAM_80S.slice(0, 1));
      assert.isTrue(yield* hasPendingMigrations());
      yield* reviveAfterKill;
      yield* previousBuildRefuses;
      assert.deepStrictEqual(yield* onRestart(reopen, runMigrations()), UPSTREAM_80S.slice(1));
      assert.deepStrictEqual(yield* onRestart(reopen, snapshot), yield* fresh);
      assert.deepStrictEqual(yield* onRestart(reopen, userData), data);
      assert.isFalse(yield* onRestart(reopen, hasPendingMigrations()));
    }).pipe(Effect.provide(open));
  });

  it.effect("a kill between two upstream migrations keeps the ones that finished", () => {
    const { open, reopen } = database();
    return Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      yield* killWhenRecording("CommandReadIndexes");
      assert.isTrue((yield* Effect.exit(runMigrations()))._tag === "Failure");
      assert.deepStrictEqual(yield* recordedUpstream80s, UPSTREAM_80S.slice(0, 3));
      assert.isTrue(yield* hasPendingMigrations());
      yield* reviveAfterKill;
      yield* previousBuildRefuses;
      assert.deepStrictEqual(yield* onRestart(reopen, runMigrations()), UPSTREAM_80S.slice(3));
      assert.deepStrictEqual(yield* onRestart(reopen, snapshot), yield* fresh);
    }).pipe(Effect.provide(open));
  });

  it.effect("a kill inside 085 rolls back its work and keeps 080-084", () => {
    const { open, reopen } = database();
    return Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      const sql = yield* SqlClient.SqlClient;
      yield* killWhenRecording("TurnItemCounts");
      assert.isTrue((yield* Effect.exit(runMigrations()))._tag === "Failure");
      assert.deepStrictEqual(yield* recordedUpstream80s, UPSTREAM_80S.slice(0, 5));
      // 085 ran in full before its ledger row; the kill rolls back its table and triggers.
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name LIKE '%turn_item_count%'`,
        [],
      );
      assert.isTrue(yield* hasPendingMigrations());
      yield* reviveAfterKill;
      yield* previousBuildRefuses;
      assert.deepStrictEqual(yield* onRestart(reopen, runMigrations()), UPSTREAM_80S.slice(5));
      assert.deepStrictEqual(yield* onRestart(reopen, snapshot), yield* fresh);
    }).pipe(Effect.provide(open));
  });

  it.effect("a kill in the later GOAT migrations keeps those that finished", () => {
    const { open, reopen } = database();
    return Effect.gen(function* () {
      // Old max 85: GOAT's first six move to 90-95; 96-157 run after upstream 080-089.
      yield* seedOldGoatLedger(85);
      const sql = yield* SqlClient.SqlClient;
      // 112 creates this table, so its body fails; the migrator writes the ledger row itself.
      yield* sql`CREATE TABLE fleet_host_states (host TEXT)`;
      assert.isTrue((yield* Effect.exit(runMigrations()))._tag === "Failure");
      assert.deepStrictEqual(yield* recordedUpstream80s, UPSTREAM_80S);
      assert.deepStrictEqual((yield* history).at(-1), currentRow("FleetGoals"));
      assert.isTrue(yield* hasPendingMigrations());
      yield* sql`DROP TABLE fleet_host_states`;
      yield* previousBuildRefuses;
      yield* onRestart(reopen, runMigrations());
      assert.deepStrictEqual(yield* onRestart(reopen, snapshot), yield* fresh);
    }).pipe(Effect.provide(open));
  });
});
