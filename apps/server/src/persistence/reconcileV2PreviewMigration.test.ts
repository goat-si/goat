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
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 131 }), [
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
        [80, "ScheduledTaskThreadMode"],
        [81, "ProjectionMessageSearchText"],
        [82, "TurnItemConversationIndex"],
        [83, "CommandReadIndexes"],
        [84, "LastExecutedRunIndex"],
        [85, "TurnItemCounts"],
        [86, "QueuedTurnInputIndex"],
        [87, "ProjectionProjectsCustomTitle"],
        [88, "TurnItemTypeStatusIndex"],
        [89, "ShellThreadReadIndexes"],
        [90, "ServerActivityIndexes"],
        [91, "RemoteReports"],
        [92, "RemoteDispatches"],
        [93, "ChannelLedger"],
        [94, "RemoteDispatchQuestions"],
        [95, "ThreadRunResults"],
        [96, "RemoteReportRelay"],
        [97, "ProjectionTurnItemRequestIndex"],
        [98, "Memory"],
        [99, "MemoryHubSync"],
        [100, "MemorySearchCounters"],
        [101, "MemoryTaskGrantCeiling"],
        [102, "MemoryImportLineage"],
        [103, "MemoryCheckpointAccounting"],
        [104, "MemoryReportLifecycle"],
        [105, "MemoryUsageCounters"],
        [106, "MemoryRevertResults"],
        [107, "HandoffLookupIndex"],
        [108, "MemoryLastReadySpace"],
        [109, "MemoryHubAdministered"],
        [110, "MemoryCheckpointLifecycle"],
        [111, "FleetGoals"],
        [112, "FleetHealth"],
        [113, "ThreadRunObservedChecks"],
        [114, "RemoteDispatchObservation"],
        [115, "MemoryRevisionCheckpointSize"],
        [116, "HubNodes"],
        [117, "MemorySummaryWorkThreadIndex"],
        [118, "ThreadHistoryArchives"],
        [119, "PermissionProfiles"],
        [120, "DecisionInbox"],
        [121, "HumanStepRecords"],
        [122, "McpRequestReservations"],
        [123, "RemoteReportInboxRunId"],
        [124, "RemoteReportReceipts"],
        [125, "PendingAttachmentUploads"],
        [126, "ScheduledTaskWebhookSecretRef"],
        [127, "RemoteReportFences"],
        [128, "HubProvisionedLinks"],
        [129, "ScheduledTaskRuns"],
        [130, "ScheduledTaskNotificationPolicy"],
        [131, "NotificationCursorRepair"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), [
        [132, "ConnectLinkTrust"],
        [133, "McpEvalJournal"],
        [134, "DecisionRoutes"],
        [135, "HubConnectAccess"],
        [136, "ChannelBotSessions"],
        [137, "MemoryGenerationReportBacklog"],
        [138, "ChannelSessionReceipts"],
        [139, "BrowserSiteNotes"],
        [140, "ComputerUseSessionApprovals"],
        [141, "ComputerUseNamedApprovals"],
        [142, "ComputerUseInputHistory"],
        [143, "MemoryCheckpointBound"],
        [144, "WorktreeSnapshots"],
        [145, "ChannelBotIds"],
        [146, "ScheduledBotRoutines"],
        [147, "RemoteDispatchDeleteIntent"],
        [148, "ChannelInterimMessages"],
        [149, "ChannelNewestAsk"],
        [150, "PlacementAdmission"],
        [151, "AuthSessionPenBinding"],
        [152, "ChannelOutboxOperations"],
        [153, "RemoteDispatchHostOutage"],
        [154, "ChannelBotTaskHistory"],
        [155, "DisposableMachines"],
        [156, "DisposableMachineRequests"],
        [157, "DisposableMachineEnrollment"],
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
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 131 }), [
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
        [80, "ScheduledTaskThreadMode"],
        [81, "ProjectionMessageSearchText"],
        [82, "TurnItemConversationIndex"],
        [83, "CommandReadIndexes"],
        [84, "LastExecutedRunIndex"],
        [85, "TurnItemCounts"],
        [86, "QueuedTurnInputIndex"],
        [87, "ProjectionProjectsCustomTitle"],
        [88, "TurnItemTypeStatusIndex"],
        [89, "ShellThreadReadIndexes"],
        [90, "ServerActivityIndexes"],
        [91, "RemoteReports"],
        [92, "RemoteDispatches"],
        [93, "ChannelLedger"],
        [94, "RemoteDispatchQuestions"],
        [95, "ThreadRunResults"],
        [96, "RemoteReportRelay"],
        [97, "ProjectionTurnItemRequestIndex"],
        [98, "Memory"],
        [99, "MemoryHubSync"],
        [100, "MemorySearchCounters"],
        [101, "MemoryTaskGrantCeiling"],
        [102, "MemoryImportLineage"],
        [103, "MemoryCheckpointAccounting"],
        [104, "MemoryReportLifecycle"],
        [105, "MemoryUsageCounters"],
        [106, "MemoryRevertResults"],
        [107, "HandoffLookupIndex"],
        [108, "MemoryLastReadySpace"],
        [109, "MemoryHubAdministered"],
        [110, "MemoryCheckpointLifecycle"],
        [111, "FleetGoals"],
        [112, "FleetHealth"],
        [113, "ThreadRunObservedChecks"],
        [114, "RemoteDispatchObservation"],
        [115, "MemoryRevisionCheckpointSize"],
        [116, "HubNodes"],
        [117, "MemorySummaryWorkThreadIndex"],
        [118, "ThreadHistoryArchives"],
        [119, "PermissionProfiles"],
        [120, "DecisionInbox"],
        [121, "HumanStepRecords"],
        [122, "McpRequestReservations"],
        [123, "RemoteReportInboxRunId"],
        [124, "RemoteReportReceipts"],
        [125, "PendingAttachmentUploads"],
        [126, "ScheduledTaskWebhookSecretRef"],
        [127, "RemoteReportFences"],
        [128, "HubProvisionedLinks"],
        [129, "ScheduledTaskRuns"],
        [130, "ScheduledTaskNotificationPolicy"],
        [131, "NotificationCursorRepair"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), [
        [132, "ConnectLinkTrust"],
        [133, "McpEvalJournal"],
        [134, "DecisionRoutes"],
        [135, "HubConnectAccess"],
        [136, "ChannelBotSessions"],
        [137, "MemoryGenerationReportBacklog"],
        [138, "ChannelSessionReceipts"],
        [139, "BrowserSiteNotes"],
        [140, "ComputerUseSessionApprovals"],
        [141, "ComputerUseNamedApprovals"],
        [142, "ComputerUseInputHistory"],
        [143, "MemoryCheckpointBound"],
        [144, "WorktreeSnapshots"],
        [145, "ChannelBotIds"],
        [146, "ScheduledBotRoutines"],
        [147, "RemoteDispatchDeleteIntent"],
        [148, "ChannelInterimMessages"],
        [149, "ChannelNewestAsk"],
        [150, "PlacementAdmission"],
        [151, "AuthSessionPenBinding"],
        [152, "ChannelOutboxOperations"],
        [153, "RemoteDispatchHostOutage"],
        [154, "ChannelBotTaskHistory"],
        [155, "DisposableMachines"],
        [156, "DisposableMachineRequests"],
        [157, "DisposableMachineEnrollment"],
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
