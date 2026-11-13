import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";

const seedPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 52 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({ "53_OrchestrationV2": OrchestrationV2 }),
  });
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports
      (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
    VALUES ('preview-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)
  `;
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-09-15 00:00:00' WHERE migration_id = 53
  `;
});

describe("V2 preview upgrade", () => {
  it.effect.each([false, true])(
    "rejects preview memory evidence before reconciliation (old ledger: %s)",
    (withOldMemoryLedger) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedPreview;
        yield* sql`CREATE TABLE memory_items (body TEXT)`;
        yield* sql`INSERT INTO memory_items VALUES ('synthetic preview memory')`;
        if (withOldMemoryLedger) {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (71, 'Memory')`;
        }
        const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`;
        const body = yield* sql`SELECT * FROM memory_items`;
        const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
        const result = yield* Effect.flip(runMigrations());
        // Check preservation before the error message so moving only the preflight exposes writes.
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          ledger,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`, schema);
        assert.deepStrictEqual(yield* sql`SELECT * FROM memory_items`, body);
        assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
        assert.instanceOf(result, Migrator.MigrationError);
        assert.strictEqual(result.kind, "BadState");
        assert.strictEqual(
          result.message,
          "Unreleased memory DB is incompatible; reset this sandbox's memory development state and restart.",
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a published preview without replaying V2 or losing import progress", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 121 }), [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        [70, "PeerLinks"],
        [71, "PeerLinkFence"],
        [72, "WaitingLinkRequestIndex"],
        [73, "ActiveTurnItemIndexes"],
        [74, "ExcludeAttachmentPlaceholdersFromSearch"],
        [75, "SubagentDeliveryState"],
        [76, "ProjectionProjectsPinArchive"],
        [77, "RepairBooleanSettledOverride"],
        [78, "DropOrchestrationEventCorrelationIndex"],
        [79, "DelegatedRecoveryIndexes"],
        [80, "ServerActivityIndexes"],
        [81, "RemoteReports"],
        [82, "RemoteDispatches"],
        [83, "ChannelLedger"],
        [84, "RemoteDispatchQuestions"],
        [85, "ThreadRunResults"],
        [86, "RemoteReportRelay"],
        [87, "ProjectionTurnItemRequestIndex"],
        [88, "Memory"],
        [89, "MemoryHubSync"],
        [90, "MemorySearchCounters"],
        [91, "MemoryTaskGrantCeiling"],
        [92, "MemoryImportLineage"],
        [93, "MemoryCheckpointAccounting"],
        [94, "MemoryReportLifecycle"],
        [95, "MemoryUsageCounters"],
        [96, "MemoryRevertResults"],
        [97, "HandoffLookupIndex"],
        [98, "MemoryLastReadySpace"],
        [99, "MemoryHubAdministered"],
        [100, "MemoryCheckpointLifecycle"],
        [101, "FleetGoals"],
        [102, "FleetHealth"],
        [103, "ThreadRunObservedChecks"],
        [104, "RemoteDispatchObservation"],
        [105, "MemoryRevisionCheckpointSize"],
        [106, "HubNodes"],
        [107, "MemorySummaryWorkThreadIndex"],
        [108, "ThreadHistoryArchives"],
        [109, "PermissionProfiles"],
        [110, "DecisionInbox"],
        [111, "HumanStepRecords"],
        [112, "McpRequestReservations"],
        [113, "RemoteReportInboxRunId"],
        [114, "RemoteReportReceipts"],
        [115, "PendingAttachmentUploads"],
        [116, "ScheduledTaskWebhookSecretRef"],
        [117, "RemoteReportFences"],
        [118, "HubProvisionedLinks"],
        [119, "ScheduledTaskRuns"],
        [120, "ScheduledTaskNotificationPolicy"],
        [121, "NotificationCursorRepair"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), [
        [122, "ConnectLinkTrust"],
        [123, "McpEvalJournal"],
        [124, "DecisionRoutes"],
        [125, "HubConnectAccess"],
        [126, "ChannelBotSessions"],
        [127, "MemoryGenerationReportBacklog"],
        [128, "ChannelSessionReceipts"],
        [129, "BrowserSiteNotes"],
        [130, "ComputerUseSessionApprovals"],
        [131, "ComputerUseNamedApprovals"],
        [132, "ComputerUseInputHistory"],
        [133, "MemoryCheckpointBound"],
        [134, "WorktreeSnapshots"],
        [135, "ChannelBotIds"],
        [136, "ScheduledBotRoutines"],
        [137, "RemoteDispatchDeleteIntent"],
        [138, "ChannelInterimMessages"],
        [139, "ChannelNewestAsk"],
        [140, "PlacementAdmission"],
        [141, "AuthSessionPenBinding"],
        [142, "ChannelOutboxOperations"],
        [143, "RemoteDispatchHostOutage"],
        [144, "ChannelBotTaskHistory"],
        [145, "DisposableMachines"],
        [146, "DisposableMachineRequests"],
        [147, "DisposableMachineEnrollment"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 55`,
        [{ created_at: "2026-09-15 00:00:00" }],
      );
      yield* sql`
        INSERT INTO pull_request_files_viewed
          (provider, host, repository, number, viewer, path, revision, viewed_at)
        VALUES ('github', 'github.com', 'owner/repo', 1, 'viewer', 'file.ts', 'revision', '2026-09-17')
      `;
      assert.strictEqual((yield* sql`SELECT * FROM pull_request_files_viewed`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "upgrades preview migration 54 with index cleanup %s",
    (withIndexes) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "53_PullRequestFilesViewed": PullRequestFilesViewed,
            "54_OrchestrationV2": OrchestrationV2,
            ...(withIndexes
              ? { "55_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes }
              : {}),
          }),
        });
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        assert.ok(columns.some((column) => column.name === "auto_settle_disabled_at"));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back schema and ledger together on failure and can retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`
        CREATE TRIGGER fail_preview_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'PullRequestFilesViewed'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53`,
        [{ migration_id: 53, name: "OrchestrationV2" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'`,
        [],
      );
      assert.strictEqual((yield* sql`SELECT * FROM orchestration_v2_legacy_imports`).length, 1);
      yield* sql`DROP TRIGGER fail_preview_upgrade`;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 121 }), [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        [70, "PeerLinks"],
        [71, "PeerLinkFence"],
        [72, "WaitingLinkRequestIndex"],
        [73, "ActiveTurnItemIndexes"],
        [74, "ExcludeAttachmentPlaceholdersFromSearch"],
        [75, "SubagentDeliveryState"],
        [76, "ProjectionProjectsPinArchive"],
        [77, "RepairBooleanSettledOverride"],
        [78, "DropOrchestrationEventCorrelationIndex"],
        [79, "DelegatedRecoveryIndexes"],
        [80, "ServerActivityIndexes"],
        [81, "RemoteReports"],
        [82, "RemoteDispatches"],
        [83, "ChannelLedger"],
        [84, "RemoteDispatchQuestions"],
        [85, "ThreadRunResults"],
        [86, "RemoteReportRelay"],
        [87, "ProjectionTurnItemRequestIndex"],
        [88, "Memory"],
        [89, "MemoryHubSync"],
        [90, "MemorySearchCounters"],
        [91, "MemoryTaskGrantCeiling"],
        [92, "MemoryImportLineage"],
        [93, "MemoryCheckpointAccounting"],
        [94, "MemoryReportLifecycle"],
        [95, "MemoryUsageCounters"],
        [96, "MemoryRevertResults"],
        [97, "HandoffLookupIndex"],
        [98, "MemoryLastReadySpace"],
        [99, "MemoryHubAdministered"],
        [100, "MemoryCheckpointLifecycle"],
        [101, "FleetGoals"],
        [102, "FleetHealth"],
        [103, "ThreadRunObservedChecks"],
        [104, "RemoteDispatchObservation"],
        [105, "MemoryRevisionCheckpointSize"],
        [106, "HubNodes"],
        [107, "MemorySummaryWorkThreadIndex"],
        [108, "ThreadHistoryArchives"],
        [109, "PermissionProfiles"],
        [110, "DecisionInbox"],
        [111, "HumanStepRecords"],
        [112, "McpRequestReservations"],
        [113, "RemoteReportInboxRunId"],
        [114, "RemoteReportReceipts"],
        [115, "PendingAttachmentUploads"],
        [116, "ScheduledTaskWebhookSecretRef"],
        [117, "RemoteReportFences"],
        [118, "HubProvisionedLinks"],
        [119, "ScheduledTaskRuns"],
        [120, "ScheduledTaskNotificationPolicy"],
        [121, "NotificationCursorRepair"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), [
        [122, "ConnectLinkTrust"],
        [123, "McpEvalJournal"],
        [124, "DecisionRoutes"],
        [125, "HubConnectAccess"],
        [126, "ChannelBotSessions"],
        [127, "MemoryGenerationReportBacklog"],
        [128, "ChannelSessionReceipts"],
        [129, "BrowserSiteNotes"],
        [130, "ComputerUseSessionApprovals"],
        [131, "ComputerUseNamedApprovals"],
        [132, "ComputerUseInputHistory"],
        [133, "MemoryCheckpointBound"],
        [134, "WorktreeSnapshots"],
        [135, "ChannelBotIds"],
        [136, "ScheduledBotRoutines"],
        [137, "RemoteDispatchDeleteIntent"],
        [138, "ChannelInterimMessages"],
        [139, "ChannelNewestAsk"],
        [140, "PlacementAdmission"],
        [141, "AuthSessionPenBinding"],
        [142, "ChannelOutboxOperations"],
        [143, "RemoteDispatchHostOutage"],
        [144, "ChannelBotTaskHistory"],
        [145, "DisposableMachines"],
        [146, "DisposableMachineRequests"],
        [147, "DisposableMachineEnrollment"],
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unexpected later migrations without modifying their history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'UnknownFork')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
