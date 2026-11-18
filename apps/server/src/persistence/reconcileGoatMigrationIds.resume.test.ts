// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  DATABASE_MIGRATION_PROGRESS_MESSAGE,
  DATABASE_MIGRATIONS_FINISHED_MESSAGE,
  DATABASE_MIGRATIONS_STARTED_MESSAGE,
  isRunningDatabaseMigrations,
} from "@goat/shared/databaseMigrationLog";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

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

/**
 * A database per test: an in-memory one, or a file that a restart reopens on a new connection and
 * that is removed once the test's connection closes.
 */
interface TestDatabase {
  readonly provide: <A, E>(
    test: Effect.Effect<A, E, SqlClient.SqlClient>,
  ) => Effect.Effect<A, E | SqlError.SqlError>;
  readonly reopen: string | null;
}
const databases: ReadonlyArray<readonly [string, () => TestDatabase]> = [
  [
    "in-memory",
    () => ({
      provide: <A, E>(test: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        test.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
      reopen: null,
    }),
  ],
  [
    "file",
    () => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-shift-resume-"));
      const filename = NodePath.join(directory, "state.sqlite");
      return {
        provide: <A, E>(test: Effect.Effect<A, E, SqlClient.SqlClient>) =>
          test.pipe(
            Effect.provide(NodeSqliteClient.layer({ filename })),
            Effect.ensuring(
              Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
            ),
          ),
        reopen: filename,
      };
    },
  ],
];

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
    const { provide, reopen } = database();
    return Effect.gen(function* () {
      yield* seed;
      assert.isTrue(yield* hasPendingMigrations());
      yield* onRestart(reopen, runMigrations());
      assert.deepStrictEqual(yield* onRestart(reopen, snapshot), yield* fresh);
      assert.deepStrictEqual(yield* onRestart(reopen, runMigrations()), []);
      assert.isFalse(yield* onRestart(reopen, hasPendingMigrations()));
    }).pipe(provide);
  });

  it.effect("brackets an upgrade's progress lines so the desktop waits for them to end", () => {
    const { provide, reopen } = database();
    return Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      const lines: Array<string> = [];
      const logger = Logger.make(({ message }) => {
        lines.push(Array.isArray(message) ? message.join(" ") : String(message));
      });
      const migrate = runMigrations().pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );
      yield* onRestart(reopen, migrate);
      const finished = lines.indexOf(DATABASE_MIGRATIONS_FINISHED_MESSAGE);
      assert.strictEqual(lines[0], DATABASE_MIGRATIONS_STARTED_MESSAGE);
      assert.isTrue(lines.includes(DATABASE_MIGRATION_PROGRESS_MESSAGE));
      for (let end = 1; end <= finished; end++) {
        assert.isTrue(isRunningDatabaseMigrations(lines.slice(0, end).join("\n")));
      }
      assert.isFalse(isRunningDatabaseMigrations(lines.join("\n")));
      lines.length = 0;
      yield* onRestart(reopen, migrate);
      assert.isFalse(lines.includes(DATABASE_MIGRATIONS_STARTED_MESSAGE));
    }).pipe(provide);
  });

  it.effect("closes an announced upgrade that runs nothing with the finished line", () => {
    const { provide, reopen } = database();
    return Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 89 });
      const lines: Array<string> = [];
      const logger = Logger.make(({ message }) => {
        lines.push(Array.isArray(message) ? message.join(" ") : String(message));
      });
      const executed = yield* onRestart(
        reopen,
        runMigrations({ toMigrationInclusive: 89 }).pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
      assert.deepStrictEqual(executed, []);
      const started = lines.indexOf(DATABASE_MIGRATIONS_STARTED_MESSAGE);
      assert.isAtLeast(started, 0);
      assert.isAbove(lines.indexOf(DATABASE_MIGRATIONS_FINISHED_MESSAGE), started);
      assert.isFalse(isRunningDatabaseMigrations(lines.join("\n")));
    }).pipe(provide);
  });

  it.effect("refuses a T3 ledger with a newer row at 90 and leaves it unchanged", () => {
    const { provide } = database();
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
    }).pipe(provide);
  });

  it.effect("a kill inside the ledger move leaves the old ledger whole", () => {
    const { provide, reopen } = database();
    return Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      const before = yield* history;
      yield* killWhenRecording(goatNames.at(-1) ?? "");
      assert.isTrue((yield* Effect.exit(runMigrations()))._tag === "Failure");
      assert.deepStrictEqual(yield* history, before);
      yield* reviveAfterKill;
      yield* onRestart(reopen, runMigrations());
      assert.deepStrictEqual(yield* onRestart(reopen, snapshot), yield* fresh);
    }).pipe(provide);
  });

  it.effect("a kill after the ledger move keeps the move with 080 and resumes with 081", () => {
    const { provide, reopen } = database();
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
    }).pipe(provide);
  });

  it.effect("a kill between two upstream migrations keeps the ones that finished", () => {
    const { provide, reopen } = database();
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
    }).pipe(provide);
  });

  it.effect("a kill inside 085 rolls back its work and keeps 080-084", () => {
    const { provide, reopen } = database();
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
    }).pipe(provide);
  });

  it.effect("a kill in the later GOAT migrations keeps those that finished", () => {
    const { provide, reopen } = database();
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
    }).pipe(provide);
  });

  it.effect.each([
    [41, "ThreadSummaryTimeline", "AuthSessionClientConnection"],
    [51, "SiteLocalMigration", "ProjectionThreadMessageContext"],
  ] as const)(
    "upgrades a ledger from before the shift that records %s under another name below 55, warning about that id only",
    ([id, name, expectedName]) => {
      const { provide, reopen } = database();
      return Effect.gen(function* () {
        yield* seedOldGoatLedger(147);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE effect_sql_migrations SET name = ${name} WHERE migration_id = ${id}`;
        const divergent: Array<unknown> = [];
        const warnings = Logger.make(({ logLevel, fiber }) => {
          if (logLevel === "Warn") {
            divergent.push(fiber.getRef(References.CurrentLogAnnotations).divergent);
          }
        });
        yield* onRestart(
          reopen,
          runMigrations().pipe(
            Effect.provide(Logger.layer([warnings], { mergeWithExisting: false })),
          ),
        );
        const expected = yield* fresh;
        const upgraded = yield* onRestart(reopen, snapshot);
        assert.deepStrictEqual(upgraded, {
          ...expected,
          ledger: expected.ledger.map((row) => (row[0] === id ? ([id, name] as const) : row)),
        });
        assert.deepStrictEqual(divergent, [[`${id}:${name} (this build: ${expectedName})`]]);
      }).pipe(provide);
    },
  );

  it.effect("a ledger from before the shift that lost row 30 commits the move with 080", () => {
    const { provide, reopen } = database();
    return Effect.gen(function* () {
      yield* seedOldGoatLedger(147);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 30`;
      yield* killWhenRecording("ProjectionMessageSearchText");
      assert.isTrue((yield* Effect.exit(runMigrations()))._tag === "Failure");
      assert.deepStrictEqual(yield* goatRows, goatNames.map(currentRow));
      assert.deepStrictEqual(yield* recordedUpstream80s, UPSTREAM_80S.slice(0, 1));
      assert.isFalse((yield* history).some(([recordedId]) => recordedId === 30));
      yield* reviveAfterKill;
      yield* previousBuildRefuses;
      assert.deepStrictEqual(yield* onRestart(reopen, runMigrations()), UPSTREAM_80S.slice(1));
      const expected = yield* fresh;
      assert.deepStrictEqual(yield* onRestart(reopen, snapshot), {
        ...expected,
        ledger: expected.ledger.filter(([id]) => id !== 30),
      });
    }).pipe(provide);
  });

  it.effect.each([
    [
      "a shifted ledger that lost row 61",
      Effect.asVoid(runMigrations()),
      [61, 61],
      "61_PullRequestReviewGuides",
      157,
    ],
    [
      "a ledger from before the shift that lost row 72",
      seedOldGoatLedger(147),
      [72, 72],
      "72_WaitingLinkRequestIndex",
      147,
    ],
    [
      "a ledger from before the shift that lost row 79, just below GOAT's old block",
      seedOldGoatLedger(147),
      [79, 79],
      "79_DelegatedRecoveryIndexes",
      147,
    ],
    [
      "a ledger from before the shift that lost rows 78 and 79",
      seedOldGoatLedger(147),
      [78, 79],
      "78_DropOrchestrationEventCorrelationIndex",
      147,
    ],
    [
      "a ledger with 1-54 and GOAT's rows at 80-147",
      seedOldGoatLedger(147),
      [55, 79],
      "55_OrchestrationV2",
      147,
    ],
  ] as const)(
    "refuses %s before writing anything, as a skipped migration",
    ([, seed, [from, to], skipped, highest]) => {
      const { provide } = database();
      return Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id BETWEEN ${from} AND ${to}`;
        const before = yield* history;
        const tables = yield* schema;
        const exit = yield* Effect.exit(runMigrations());
        const failure = exit._tag === "Failure" ? String(Cause.squash(exit.cause)) : "started";
        assert.include(failure, "would skip required schema migrations");
        assert.include(failure, `${skipped} (recorded: nothing)`);
        assert.include(failure, `highest recorded id (${highest})`);
        assert.deepStrictEqual(yield* history, before);
        assert.deepStrictEqual(yield* schema, tables);
      }).pipe(provide);
    },
  );

  it.effect("starts a shifted ledger that lost row 7 and leaves the gap, as before", () => {
    const { provide } = database();
    return Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 7`;
      const before = yield* history;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* history, before);
      assert.isFalse(yield* hasPendingMigrations());
    }).pipe(provide);
  });
});
