import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { GOAT_MIGRATION_NAMES, reconcileGoatMigrationIds } from "./reconcileGoatMigrationIds.ts";
import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

// GOAT builds record GOAT's own migrations right after the last upstream one they knew:
// at 61 before the sync that added PullRequestReviewGuides, at 62 before the one that
// added ThreadFailureLookupIndex, at 63 before the one that added DropUnusedV1Projections, at 64
// before the one that added CanonicalizeThreadPullRequestLinks, and at 65 before the one that
// added CodexUsageNativeTurnIndex, RepairClientSettlementTimestamps and WebhookDedupe.
const seedGoatLedger = (names: ReadonlyArray<string>, firstGoatId = 61) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: firstGoatId - 1 });
    const byName = new Map<string, (typeof migrationEntries)[number][2]>(
      migrationEntries.map(([, name, migration]) => [name, migration]),
    );
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          names.map((name, index) => [`${firstGoatId + index}_${name}`, byName.get(name)!]),
        ),
      ),
    });
  });

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const goatNames = migrationEntries.flatMap(([, name]) =>
  GOAT_MIGRATION_NAMES.has(name) ? [name] : [],
);

const hasReviewGuides = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_review_guides'
  `;
  return tables.length === 1;
});

const skippedUpstreamMigrations = [
  [61, "PullRequestReviewGuides"],
  [62, "ThreadFailureLookupIndex"],
  [63, "DropUnusedV1Projections"],
  [64, "CanonicalizeThreadPullRequestLinks"],
  [65, "CodexUsageNativeTurnIndex"],
  [66, "RepairClientSettlementTimestamps"],
  [67, "WebhookDedupe"],
] as const;
const laterGoatMigrations = [
  [76, "Memory"],
  [77, "MemoryHubSync"],
  [78, "MemorySearchCounters"],
  [79, "MemoryTaskGrantCeiling"],
  [80, "MemoryImportLineage"],
  [81, "MemoryCheckpointAccounting"],
  [82, "MemoryReportLifecycle"],
  [83, "MemoryUsageCounters"],
  [84, "MemoryRevertResults"],
  [85, "HandoffLookupIndex"],
  [86, "MemoryLastReadySpace"],
  [87, "MemoryHubAdministered"],
  [88, "MemoryCheckpointLifecycle"],
  [89, "FleetGoals"],
  [90, "FleetHealth"],
  [91, "ThreadRunObservedChecks"],
  [92, "RemoteDispatchObservation"],
  [93, "MemoryRevisionCheckpointSize"],
  [94, "HubNodes"],
  [95, "MemorySummaryWorkThreadIndex"],
  [96, "ThreadHistoryArchives"],
  [97, "PermissionProfiles"],
  [98, "DecisionInbox"],
  [99, "HumanStepRecords"],
] as const;
const preMemoryGoatNames = [
  "ServerActivityIndexes",
  "RemoteReports",
  "RemoteDispatches",
  "ChannelLedger",
  "RemoteDispatchQuestions",
  "ThreadRunResults",
  "RemoteReportRelay",
  "ProjectionTurnItemRequestIndex",
];

describe("GOAT migration ids", () => {
  it.effect.each([
    ["ledger before WebhookDedupe", 65, goatNames, skippedUpstreamMigrations.slice(4)],
    [
      "ledger before CanonicalizeThreadPullRequestLinks",
      64,
      goatNames,
      skippedUpstreamMigrations.slice(3),
    ],
    ["ledger before DropUnusedV1Projections", 63, goatNames, skippedUpstreamMigrations.slice(2)],
    [
      "pre-memory ledger",
      61,
      preMemoryGoatNames,
      [...skippedUpstreamMigrations, ...laterGoatMigrations],
    ],
    [
      "partial pre-memory ledger",
      61,
      ["ServerActivityIndexes", "RemoteReports", "RemoteDispatches"],
      [
        ...skippedUpstreamMigrations,
        [71, "ChannelLedger"],
        [72, "RemoteDispatchQuestions"],
        [73, "ThreadRunResults"],
        [74, "RemoteReportRelay"],
        [75, "ProjectionTurnItemRequestIndex"],
        ...laterGoatMigrations,
      ],
    ],
    [
      "ledger after PullRequestReviewGuides",
      62,
      preMemoryGoatNames,
      [...skippedUpstreamMigrations.slice(1), ...laterGoatMigrations],
    ],
  ] as const)(
    "repairs %s and restarts without reapplying migrations",
    ([_title, firstGoatId, names, expected]) =>
      Effect.gen(function* () {
        yield* seedGoatLedger(names, firstGoatId);
        if (firstGoatId === 61) assert.isFalse(yield* hasReviewGuides);
        assert.deepStrictEqual(yield* runMigrations(), [...expected]);
        assert.isTrue(yield* hasReviewGuides);
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// Synthetic ledgers/tables only: the rejection must preserve all startup evidence.
describe("unreleased memory DB", () => {
  it.effect("rejects an old memory ledger before moving any GOAT ids", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 75 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 174 WHERE name = 'RemoteReportRelay'`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (75 + 100, 'Memory')`;
      // The old Memory id may collide with dev's index, so model the actual pre-sync ledger.
      yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'ProjectionTurnItemRequestIndex'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 75 WHERE name = 'Memory'`;
      const before = yield* history;
      const result = yield* Effect.flip(runMigrations());
      assert.strictEqual(result._tag, "MigrationError");
      if (result._tag !== "MigrationError") return yield* result;
      assert.strictEqual(result.kind, "BadState");
      assert.include(result.message, "Unreleased memory DB is incompatible");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects old memory when other GOAT ids already match", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 75 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'ProjectionTurnItemRequestIndex'`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (75, 'Memory')`;
      const before = yield* history;
      const result = yield* Effect.flip(reconcileGoatMigrationIds(migrationEntries));
      if (result._tag !== "MigrationError") return yield* result;
      assert.strictEqual(result.kind, "BadState");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects memory tables without a ledger and preserves their contents", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE memory_items (body TEXT)`;
      yield* sql`INSERT INTO memory_items VALUES ('synthetic sandbox fixture')`;
      const result = yield* Effect.flip(runMigrations());
      if (result._tag !== "MigrationError") return yield* result;
      assert.strictEqual(result.kind, "BadState");
      assert.deepStrictEqual(yield* sql`SELECT body FROM memory_items`, [
        { body: "synthetic sandbox fixture" },
      ]);
      assert.strictEqual(
        (yield* sql`SELECT name FROM sqlite_master WHERE name='effect_sql_migrations'`).length,
        0,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects unrecorded memory tables in an ordinary dev ledger", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 75 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE memory_payloads (body TEXT)`;
      const before = yield* history;
      const result = yield* Effect.flip(runMigrations());
      if (result._tag !== "MigrationError") return yield* result;
      assert.strictEqual(result.kind, "BadState");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades an ordinary dev DB without memory and restarts normally", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 75 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE unrelated_state (value TEXT)`;
      yield* sql`INSERT INTO unrelated_state VALUES ('keep')`;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > 75),
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT value FROM unrelated_state`, [{ value: "keep" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

it.effect("validates later Memory migrations against the registry without a fixed id list", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id,name) VALUES (999,'MemoryFutureFixture')`;
    const unknown = yield* Effect.flip(reconcileGoatMigrationIds(migrationEntries));
    if (unknown._tag !== "MigrationError") return yield* unknown;
    assert.strictEqual(unknown.kind, "BadState");
    const incoming = [...migrationEntries, [999, "MemoryFutureFixture", Effect.void] as const];
    assert.deepStrictEqual(yield* reconcileGoatMigrationIds(incoming), []);
    yield* sql`UPDATE effect_sql_migrations SET migration_id=998 WHERE name='MemoryFutureFixture'`;
    const before = yield* history;
    const stale = yield* Effect.flip(reconcileGoatMigrationIds(incoming));
    if (stale._tag !== "MigrationError") return yield* stale;
    assert.strictEqual(stale.kind, "BadState");
    assert.deepStrictEqual(yield* history, before);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

// WP5 names are stable registration keys; old ordinals must never migrate data.
it.effect.each([
  { name: "MemoryImportLineage", oldId: 79 },
  { name: "MemoryCheckpointAccounting", oldId: 80 },
] as const)(
  "rejects the old $name ordinal $oldId without changing schema or ledger",
  ({ name, oldId }) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id=${oldId}`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id=${oldId} WHERE name=${name}`;
      const before = yield* history;
      const schema = yield* sql`SELECT name,sql FROM sqlite_master ORDER BY name`;
      const failure = yield* Effect.flip(runMigrations());
      assert.strictEqual(failure._tag, "MigrationError");
      if (failure._tag === "MigrationError") {
        assert.strictEqual(failure.kind, "BadState");
        assert.include(failure.message, "Unreleased memory DB is incompatible");
      }
      assert.deepStrictEqual(yield* history, before);
      assert.deepStrictEqual(yield* sql`SELECT name,sql FROM sqlite_master ORDER BY name`, schema);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("restarts the current WP5 registry without rewriting lineage or accounting", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const before =
      yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
    const schema = yield* sql`SELECT name,sql FROM sqlite_master ORDER BY name`;
    assert.deepStrictEqual(
      migrationManifest.filter(([id]) => id >= 80),
      [
        [80, "MemoryImportLineage"],
        [81, "MemoryCheckpointAccounting"],
        [82, "MemoryReportLifecycle"],
        [83, "MemoryUsageCounters"],
        [84, "MemoryRevertResults"],
        [85, "HandoffLookupIndex"],
        [86, "MemoryLastReadySpace"],
        [87, "MemoryHubAdministered"],
        [88, "MemoryCheckpointLifecycle"],
        ...migrationManifest.filter(([id]) => id > 88),
      ],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* history, migrationManifest);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
      before,
    );
    assert.deepStrictEqual(yield* sql`SELECT name,sql FROM sqlite_master ORDER BY name`, schema);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
