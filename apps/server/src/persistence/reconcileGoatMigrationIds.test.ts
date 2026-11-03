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
// before the one that added CanonicalizeThreadPullRequestLinks, at 65 before the one that
// added CodexUsageNativeTurnIndex, RepairClientSettlementTimestamps and WebhookDedupe, at 68
// before the one that added ShellStopRequestIndex, and at 69 before the one that added
// ThreadMessageSearch.
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
  [68, "ShellStopRequestIndex"],
  [69, "ThreadMessageSearch"],
  ...migrationManifest.filter(([id]) => id >= 70 && id <= 78),
] as const;
const laterGoatMigrations = [
  [87, "Memory"],
  [88, "MemoryHubSync"],
  [89, "MemorySearchCounters"],
  [90, "MemoryTaskGrantCeiling"],
  [91, "MemoryImportLineage"],
  [92, "MemoryCheckpointAccounting"],
  [93, "MemoryReportLifecycle"],
  [94, "MemoryUsageCounters"],
  [95, "MemoryRevertResults"],
  [96, "HandoffLookupIndex"],
  [97, "MemoryLastReadySpace"],
  [98, "MemoryHubAdministered"],
  [99, "MemoryCheckpointLifecycle"],
  [100, "FleetGoals"],
  [101, "FleetHealth"],
  [102, "ThreadRunObservedChecks"],
  [103, "RemoteDispatchObservation"],
  [104, "MemoryRevisionCheckpointSize"],
  [105, "HubNodes"],
  [106, "MemorySummaryWorkThreadIndex"],
  [107, "ThreadHistoryArchives"],
  [108, "PermissionProfiles"],
  [109, "DecisionInbox"],
  [110, "HumanStepRecords"],
  [111, "McpRequestReservations"],
  [112, "RemoteReportInboxRunId"],
  [113, "RemoteReportReceipts"],
  [114, "PendingAttachmentUploads"],
  [115, "ScheduledTaskWebhookSecretRef"],
  [116, "RemoteReportFences"],
  [117, "HubProvisionedLinks"],
  [118, "ScheduledTaskRuns"],
  [119, "ScheduledTaskNotificationPolicy"],
  [120, "NotificationCursorRepair"],
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
  it.effect("moves the 70-123 ledger and applies upstream 70-78 exactly once", () =>
    Effect.gen(function* () {
      yield* seedGoatLedger(goatNames, 70);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_payloads (space, payload_ref, memory_id, body_json, dependencies_json) VALUES ('test', 'ref', 'memory', '{"text":"preserve"}', '[]')`;
      const moved = yield* runMigrations();
      assert.deepStrictEqual(
        moved.map(([id]) => id),
        [70, 71, 72, 73, 74, 75, 76, 77, 78],
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.strictEqual(
        migrationManifest.find(([, name]) => name === "ServerActivityIndexes")?.[0],
        79,
      );
      assert.strictEqual(
        migrationManifest.find(([, name]) => name === "MemoryCheckpointBound")?.[0],
        132,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT body_json FROM memory_payloads WHERE payload_ref = 'ref'`,
        [{ body_json: '{"text":"preserve"}' }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("retries an interrupted relocation without changing the old schema or ledger", () =>
    Effect.gen(function* () {
      yield* seedGoatLedger(goatNames, 70);
      const sql = yield* SqlClient.SqlClient;
      const before = yield* history;
      const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
      const failing = migrationEntries.map((entry) =>
        entry[0] === 76
          ? ([entry[0], entry[1], sql`SELECT * FROM missing_migration_fixture`] as const)
          : entry,
      );
      const failure = yield* Effect.flip(reconcileGoatMigrationIds(failing));
      assert.strictEqual(failure._tag, "MigrationError");
      assert.deepStrictEqual(yield* history, before);
      assert.deepStrictEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, schema);
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("finishes a partial old 70-series ledger after a restart", () =>
    Effect.gen(function* () {
      yield* seedGoatLedger(goatNames.slice(0, 3), 70);
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("accepts already-present upstream schemas and safely reruns all nine migrations", () =>
    Effect.gen(function* () {
      yield* seedGoatLedger(goatNames, 70);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE projection_projects ADD COLUMN pinned_at TEXT`;
      yield* sql`ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN completion_delivery_state TEXT`;
      yield* runMigrations();
      const before = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
      for (const [id, , migration] of migrationEntries) {
        if (id >= 70 && id <= 78) yield* migration;
      }
      assert.deepStrictEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, before);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect.each([
    ["ledger before ThreadMessageSearch", 69, goatNames, skippedUpstreamMigrations.slice(8)],
    ["ledger before ShellStopRequestIndex", 68, goatNames, skippedUpstreamMigrations.slice(7)],
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
        [82, "ChannelLedger"],
        [83, "RemoteDispatchQuestions"],
        [84, "ThreadRunResults"],
        [85, "RemoteReportRelay"],
        [86, "ProjectionTurnItemRequestIndex"],
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
        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 120 }), [...expected]);
        yield* runMigrations();
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
      yield* runMigrations({ toMigrationInclusive: 86 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 175 WHERE name = 'RemoteReportRelay'`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (77 + 100, 'Memory')`;
      // The old Memory id may collide with dev's index, so model the actual pre-sync ledger.
      yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'ProjectionTurnItemRequestIndex'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 86 WHERE name = 'Memory'`;
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
      yield* runMigrations({ toMigrationInclusive: 86 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'ProjectionTurnItemRequestIndex'`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (86, 'Memory')`;
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
      yield* runMigrations({ toMigrationInclusive: 86 });
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
      yield* runMigrations({ toMigrationInclusive: 86 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE unrelated_state (value TEXT)`;
      yield* sql`INSERT INTO unrelated_state VALUES ('keep')`;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > 86),
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
  { name: "MemoryImportLineage", oldId: 80 },
  { name: "MemoryCheckpointAccounting", oldId: 81 },
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
      migrationManifest.filter(([id]) => id >= 91),
      [
        [91, "MemoryImportLineage"],
        [92, "MemoryCheckpointAccounting"],
        [93, "MemoryReportLifecycle"],
        [94, "MemoryUsageCounters"],
        [95, "MemoryRevertResults"],
        [96, "HandoffLookupIndex"],
        [97, "MemoryLastReadySpace"],
        [98, "MemoryHubAdministered"],
        [99, "MemoryCheckpointLifecycle"],
        ...migrationManifest.filter(([id]) => id > 99),
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

// Nightly 0.1.2-nightly.20261023.256 (5e16fe96a1) and every GOAT build before cycle 261024
// recorded GOAT's migrations at 68-101. Upstream 068 (ShellStopRequestIndex) took 68, so GOAT's
// rows move up; since cycle 261026 (upstream 069 ThreadMessageSearch) they sit at 70-103. These cases
// pin what installs that ran 256 see when they upgrade.
const NIGHTLY_256_GOAT_LEDGER = [
  [68, "ServerActivityIndexes"],
  [69, "RemoteReports"],
  [70, "RemoteDispatches"],
  [71, "ChannelLedger"],
  [72, "RemoteDispatchQuestions"],
  [73, "ThreadRunResults"],
  [74, "RemoteReportRelay"],
  [75, "ProjectionTurnItemRequestIndex"],
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
  [100, "McpRequestReservations"],
  [101, "RemoteReportInboxRunId"],
] as const;

/** Upstream 1-67 as this build runs them, then the given 256-era GOAT rows under their old ids. */
const seedNightly256Ledger = (goatRows: ReadonlyArray<readonly [number, string]>) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 67 });
    const byName = new Map<string, (typeof migrationEntries)[number][2]>(
      migrationEntries.map(([, name, migration]) => [name, migration]),
    );
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(goatRows.map(([id, name]) => [`${id}_${name}`, byName.get(name)!])),
      ),
    });
  });

const hasShellStopIndex = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const indexes = yield* sql`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name = 'orchestration_v2_projection_turn_items_stop_request_idx'
 `;
  return indexes.length === 1;
});

const currentGoatRow = (name: string) =>
  migrationManifest.find(([, entryName]) => entryName === name)!;
// GOAT migrations added after nightly 256 are new to its ledger and run on upgrade at their ids.
const GOAT_SINCE_256 = [
  "RemoteReportReceipts",
  "PendingAttachmentUploads",
  "ScheduledTaskWebhookSecretRef",
  "RemoteReportFences",
  "HubProvisionedLinks",
  "ScheduledTaskRuns",
  "ScheduledTaskNotificationPolicy",
  "NotificationCursorRepair",
].map(currentGoatRow);

describe("upgrading a nightly 256 ledger past upstream 068", () => {
  it.effect("a new database runs every migration once, upstream 068 included", () =>
    Effect.gen(function* () {
      assert.isTrue(
        migrationManifest.every(
          ([id], index) => index === 0 || id > migrationManifest[index - 1]![0],
        ),
      );
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      assert.isTrue(yield* hasShellStopIndex);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("a 256 ledger runs upstream 068 and newer GOAT, and moves its GOAT rows unrerun", () =>
    Effect.gen(function* () {
      yield* seedNightly256Ledger(NIGHTLY_256_GOAT_LEDGER);
      assert.isFalse(yield* hasShellStopIndex);
      // GOAT bodies such as ServerActivityIndexes' ALTER TABLE fail if run twice.
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 120 }), [
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        ...migrationManifest.filter(([id]) => id >= 70 && id <= 78),
        ...GOAT_SINCE_256,
      ]);
      yield* runMigrations();
      assert.isTrue(yield* hasShellStopIndex);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([
    ["an older nightly that stopped before Memory", 8],
    ["an older nightly that stopped before HubNodes", 26],
  ] as const)("%s moves what it recorded and runs the rest at their new ids", ([, recorded]) =>
    Effect.gen(function* () {
      yield* seedNightly256Ledger(NIGHTLY_256_GOAT_LEDGER.slice(0, recorded));
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 120 }), [
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        ...migrationManifest.filter(([id]) => id >= 70 && id <= 78),
        ...NIGHTLY_256_GOAT_LEDGER.slice(recorded).map(([, name]) => currentGoatRow(name)),
        ...GOAT_SINCE_256,
      ]);
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("a database this build left partway resumes at the next migration", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 80 });
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > 80),
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("nightly 256 refuses a database this build migrated and leaves it unchanged", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const before = yield* history;
      const schema = yield* sql`SELECT name,sql FROM sqlite_master ORDER BY name`;
      // 256's manifest: no upstream 068 or 069, GOAT two ids lower.
      const nightly256Entries = migrationEntries.flatMap(([id, name, migration]) =>
        name === "ShellStopRequestIndex" || name === "ThreadMessageSearch"
          ? []
          : [[GOAT_MIGRATION_NAMES.has(name) ? id - 2 : id, name, migration] as const],
      );
      const failure = yield* Effect.flip(reconcileGoatMigrationIds(nightly256Entries));
      assert.strictEqual(failure._tag, "MigrationError");
      if (failure._tag === "MigrationError") assert.strictEqual(failure.kind, "BadState");
      assert.deepStrictEqual(yield* history, before);
      assert.deepStrictEqual(yield* sql`SELECT name,sql FROM sqlite_master ORDER BY name`, schema);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// GOAT 0.1.1 and every build before cycle 261026 recorded GOAT's migrations at 69-107. Upstream 069
// (ThreadMessageSearch) took 69, so those rows move to 70-108 and the search index is built once.
describe("upgrading a 0.1.1 ledger past upstream 069", () => {
  it.effect("builds the message search index and moves GOAT rows without rerunning them", () =>
    Effect.gen(function* () {
      yield* seedGoatLedger(goatNames, 69);
      const sql = yield* SqlClient.SqlClient;
      const searchTable = sql`
        SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
      `;
      assert.deepStrictEqual(yield* searchTable, []);
      assert.deepStrictEqual(yield* runMigrations(), [
        [69, "ThreadMessageSearch"],
        ...migrationManifest.filter(([id]) => id >= 70 && id <= 78),
      ]);
      assert.lengthOf(yield* searchTable, 1);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

it.effect("relocates ScheduledTaskRuns without changing populated receipts or associations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedGoatLedger(goatNames, 69);
    yield* sql`INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count,last_firing_id)
      VALUES ('task','Synthetic','Synthetic',1,'{}','project','{}','{}','full-access','default','user','web','2026-10-15','2026-10-15','running',1,'firing')`;
    yield* sql`INSERT INTO scheduled_task_runs (firing_id,task_id,task_created_at,message_id,trigger_kind,admitted_next_run_at,admitted_schedule_digest,admitted_enabled,dispatch_status,status,requested_at,snapshot_json)
      VALUES ('firing','task','2026-10-15','message','manual',NULL,'{}',1,'dispatching','dispatching','2026-10-15','{}')`;
    const receipts = yield* sql`SELECT * FROM scheduled_task_runs`;
    const tasks = yield* sql`SELECT last_firing_id FROM scheduled_tasks`;
    yield* reconcileGoatMigrationIds(migrationEntries);
    yield* runMigrations();
    assert.deepStrictEqual(yield* sql`SELECT * FROM scheduled_task_runs`, receipts);
    assert.deepStrictEqual(yield* sql`SELECT last_firing_id FROM scheduled_tasks`, tasks);
    assert.includeDeepMembers(yield* history, [[118, "ScheduledTaskRuns"]]);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
