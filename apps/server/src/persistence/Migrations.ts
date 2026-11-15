import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  assertMemoryMigrationsCompatible,
  displacedUpstreamMigrations,
  FIRST_V2_MIGRATION_ID,
  goatMigrationIdsMove,
  reconcileGoatMigrationIds,
  skippedV2Migrations,
} from "./reconcileGoatMigrationIds.ts";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";
import { DatabaseNewerThanBuildError } from "./Errors.ts";

import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0053 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Migration0055 from "./Migrations/055_OrchestrationV2.ts";
import Migration0056 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import Migration0057 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Migration0058 from "./Migrations/058_WebhookRelayDeliveries.ts";
import Migration0059 from "./Migrations/059_McpAppModelContext.ts";
import Migration0060 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";
import Migration0061 from "./Migrations/061_PullRequestReviewGuides.ts";
import Migration0062 from "./Migrations/062_ThreadFailureLookupIndex.ts";
import Migration0063 from "./Migrations/063_DropUnusedV1Projections.ts";
import Migration0064 from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";
import Migration0065 from "./Migrations/065_CodexUsageNativeTurnIndex.ts";
import Migration0066 from "./Migrations/066_RepairClientSettlementTimestamps.ts";
import Migration0067 from "./Migrations/067_WebhookDedupe.ts";
import Migration0068 from "./Migrations/068_ShellStopRequestIndex.ts";
import Migration0069 from "./Migrations/069_ThreadMessageSearch.ts";
import Migration0070 from "./Migrations/070_PeerLinks.ts";
import Migration0071 from "./Migrations/071_PeerLinkFence.ts";
import Migration0072 from "./Migrations/072_WaitingLinkRequestIndex.ts";
import Migration0073 from "./Migrations/073_ActiveTurnItemIndexes.ts";
import Migration0074 from "./Migrations/074_ExcludeAttachmentPlaceholdersFromSearch.ts";
import Migration0075 from "./Migrations/075_SubagentDeliveryState.ts";
import Migration0076 from "./Migrations/076_ProjectionProjectsPinArchive.ts";
import Migration0077 from "./Migrations/077_RepairBooleanSettledOverride.ts";
import Migration0078 from "./Migrations/078_DropOrchestrationEventCorrelationIndex.ts";
import Migration0079 from "./Migrations/079_DelegatedRecoveryIndexes.ts";
import Migration0080 from "./Migrations/080_ScheduledTaskThreadMode.ts";
import Migration0081 from "./Migrations/081_ProjectionMessageSearchText.ts";
import Migration0082 from "./Migrations/082_TurnItemConversationIndex.ts";
import Migration0083 from "./Migrations/083_CommandReadIndexes.ts";
import Migration0084 from "./Migrations/084_LastExecutedRunIndex.ts";
import Migration0085 from "./Migrations/085_TurnItemCounts.ts";
import Migration0086 from "./Migrations/086_QueuedTurnInputIndex.ts";
import Migration0087 from "./Migrations/087_ProjectionProjectsCustomTitle.ts";
import Migration0088 from "./Migrations/088_TurnItemTypeStatusIndex.ts";
import Migration0089 from "./Migrations/089_ShellThreadReadIndexes.ts";
import Migration0090 from "./Migrations/090_ServerActivityIndexes.ts";
import Migration0091 from "./Migrations/091_RemoteReports.ts";
import Migration0092 from "./Migrations/092_RemoteDispatches.ts";
import Migration0093 from "./Migrations/093_ChannelLedger.ts";
import Migration0094 from "./Migrations/094_RemoteDispatchQuestions.ts";
import Migration0095 from "./Migrations/095_ThreadRunResults.ts";
import Migration0096 from "./Migrations/096_RemoteReportRelay.ts";
import Migration0097 from "./Migrations/097_ProjectionTurnItemRequestIndex.ts";
import Migration0098 from "./Migrations/098_Memory.ts";
import Migration0099 from "./Migrations/099_MemoryHubSync.ts";
import Migration0100 from "./Migrations/100_MemorySearchCounters.ts";
import Migration0101 from "./Migrations/101_MemoryTaskGrantCeiling.ts";
import Migration0102 from "./Migrations/102_MemoryImportLineage.ts";
import Migration0103 from "./Migrations/103_MemoryCheckpointAccounting.ts";
import Migration0104 from "./Migrations/104_MemoryReportLifecycle.ts";
import Migration0105 from "./Migrations/105_MemoryUsageCounters.ts";
import Migration0106 from "./Migrations/106_MemoryRevertResults.ts";
import Migration0107 from "./Migrations/107_HandoffLookupIndex.ts";
import Migration0108 from "./Migrations/108_MemoryLastReadySpace.ts";
import Migration0109 from "./Migrations/109_MemoryHubAdministered.ts";
import Migration0110 from "./Migrations/110_MemoryCheckpointLifecycle.ts";
import Migration0111 from "./Migrations/111_FleetGoals.ts";
import Migration0112 from "./Migrations/112_FleetHealth.ts";
import Migration0113 from "./Migrations/113_ThreadRunObservedChecks.ts";
import Migration0114 from "./Migrations/114_RemoteDispatchObservation.ts";
import Migration0115 from "./Migrations/115_MemoryRevisionCheckpointSize.ts";
import Migration0116 from "./Migrations/116_HubNodes.ts";
import Migration0117 from "./Migrations/117_MemorySummaryWorkThreadIndex.ts";
import Migration0118 from "./Migrations/118_ThreadHistoryArchives.ts";
import Migration0119 from "./Migrations/119_PermissionProfiles.ts";
import Migration0120 from "./Migrations/120_DecisionInbox.ts";
import Migration0121 from "./Migrations/121_HumanStepRecords.ts";
import Migration0122 from "./Migrations/122_McpRequestReservations.ts";
import Migration0123 from "./Migrations/123_RemoteReportInboxRunId.ts";
import Migration0124 from "./Migrations/124_RemoteReportReceipts.ts";
import Migration0125 from "./Migrations/125_PendingAttachmentUploads.ts";
import Migration0126 from "./Migrations/126_ScheduledTaskWebhookSecretRef.ts";
import Migration0127 from "./Migrations/127_RemoteReportFences.ts";
import Migration0128 from "./Migrations/128_HubProvisionedLinks.ts";
import Migration0129 from "./Migrations/129_ScheduledTaskRuns.ts";
import Migration0130 from "./Migrations/130_ScheduledTaskNotificationPolicy.ts";
import Migration0132 from "./Migrations/132_ConnectLinkTrust.ts";
import Migration0137 from "./Migrations/137_MemoryGenerationReportBacklog.ts";
import Migration0138 from "./Migrations/138_ChannelSessionReceipts.ts";
import Migration0139 from "./Migrations/139_BrowserSiteNotes.ts";
import Migration0140 from "./Migrations/140_ComputerUseSessionApprovals.ts";
import Migration0141 from "./Migrations/141_ComputerUseNamedApprovals.ts";
import Migration0142 from "./Migrations/142_ComputerUseInputHistory.ts";
import Migration0143 from "./Migrations/143_MemoryCheckpointBound.ts";
import Migration0144 from "./Migrations/144_WorktreeSnapshots.ts";
import Migration0145 from "./Migrations/145_ChannelBotIds.ts";
import Migration0146 from "./Migrations/146_ScheduledBotRoutines.ts";
import Migration0147 from "./Migrations/147_RemoteDispatchDeleteIntent.ts";
import Migration0148 from "./Migrations/148_ChannelInterimMessages.ts";
import Migration0149 from "./Migrations/149_ChannelNewestAsk.ts";
import Migration0150 from "./Migrations/150_PlacementAdmission.ts";
import Migration0151 from "./Migrations/151_AuthSessionPenBinding.ts";
import Migration0152 from "./Migrations/152_ChannelOutboxOperations.ts";
import Migration0153 from "./Migrations/153_RemoteDispatchHostOutage.ts";
import Migration0154 from "./Migrations/154_ChannelBotTaskHistory.ts";
import Migration0155 from "./Migrations/155_DisposableMachines.ts";
import Migration0156 from "./Migrations/156_DisposableMachineRequests.ts";
import Migration0157 from "./Migrations/157_DisposableMachineEnrollment.ts";
import Migration0131 from "./Migrations/131_NotificationCursorRepair.ts";
import Migration0133 from "./Migrations/133_McpEvalJournal.ts";
import Migration0134 from "./Migrations/134_DecisionRoutes.ts";
import Migration0135 from "./Migrations/135_HubConnectAccess.ts";
import Migration0136 from "./Migrations/136_ChannelBotSessions.ts";

export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "AuthSessionClientConnection", Migration0041],
  [42, "ProjectionThreadLinkedPullRequest", Migration0042],
  [43, "ProjectionThreadsUnsettledAt", Migration0043],
  [44, "ClearAutomaticProjectModelDefaults", Migration0044],
  [45, "ProjectionProjectsAutoPull", Migration0045],
  [46, "RepairAutomaticSettlementTimestamps", Migration0046],
  [47, "ProjectionProjectIcon", Migration0047],
  [48, "ProjectionThreadBranchPullRequest", Migration0048],
  [49, "ProjectionThreadsActiveOrderKey", Migration0049],
  [50, "ProjectionThreadPullRequests", Migration0050],
  [51, "ProjectionThreadMessageContext", Migration0051],
  [52, "ProjectionThreadTitleState", Migration0052],
  [53, "PullRequestFilesViewed", Migration0053],
  [54, "ProjectionThreadsAutoSettleDisabledAt", Migration0054],
  // Preserve this migration's schema. Future V2 schema changes need new migrations.
  [55, "OrchestrationV2", Migration0055],
  [56, "RemoveRedundantProjectionIndexes", Migration0056],
  [57, "ScheduledTaskWebhooks", Migration0057],
  [58, "WebhookRelayDeliveries", Migration0058],
  [59, "McpAppModelContext", Migration0059],
  [60, "ThreadSnapshotWindowIndexes", Migration0060],
  [61, "PullRequestReviewGuides", Migration0061],
  [62, "ThreadFailureLookupIndex", Migration0062],
  [63, "DropUnusedV1Projections", Migration0063],
  [64, "CanonicalizeThreadPullRequestLinks", Migration0064],
  [65, "CodexUsageNativeTurnIndex", Migration0065],
  [66, "RepairClientSettlementTimestamps", Migration0066],
  [67, "WebhookDedupe", Migration0067],
  [68, "ShellStopRequestIndex", Migration0068],
  [69, "ThreadMessageSearch", Migration0069],
  [70, "PeerLinks", Migration0070],
  [71, "PeerLinkFence", Migration0071],
  [72, "WaitingLinkRequestIndex", Migration0072],
  [73, "ActiveTurnItemIndexes", Migration0073],
  [74, "ExcludeAttachmentPlaceholdersFromSearch", Migration0074],
  [75, "SubagentDeliveryState", Migration0075],
  [76, "ProjectionProjectsPinArchive", Migration0076],
  [77, "RepairBooleanSettledOverride", Migration0077],
  [78, "DropOrchestrationEventCorrelationIndex", Migration0078],
  [79, "DelegatedRecoveryIndexes", Migration0079],
  [80, "ScheduledTaskThreadMode", Migration0080],
  [81, "ProjectionMessageSearchText", Migration0081],
  [82, "TurnItemConversationIndex", Migration0082],
  [83, "CommandReadIndexes", Migration0083],
  [84, "LastExecutedRunIndex", Migration0084],
  [85, "TurnItemCounts", Migration0085],
  [86, "QueuedTurnInputIndex", Migration0086],
  [87, "ProjectionProjectsCustomTitle", Migration0087],
  [88, "TurnItemTypeStatusIndex", Migration0088],
  [89, "ShellThreadReadIndexes", Migration0089],
  // GOAT's own migrations follow upstream's. When an upstream sync claims these ids, move them
  // up and add the names to GOAT_MIGRATION_NAMES; reconcileGoatMigrationIds fixes old ledgers.
  [90, "ServerActivityIndexes", Migration0090],
  [91, "RemoteReports", Migration0091],
  [92, "RemoteDispatches", Migration0092],
  [93, "ChannelLedger", Migration0093],
  [94, "RemoteDispatchQuestions", Migration0094],
  [95, "ThreadRunResults", Migration0095],
  [96, "RemoteReportRelay", Migration0096],
  [97, "ProjectionTurnItemRequestIndex", Migration0097],
  [98, "Memory", Migration0098],
  [99, "MemoryHubSync", Migration0099],
  [100, "MemorySearchCounters", Migration0100],
  [101, "MemoryTaskGrantCeiling", Migration0101],
  [102, "MemoryImportLineage", Migration0102],
  [103, "MemoryCheckpointAccounting", Migration0103],
  [104, "MemoryReportLifecycle", Migration0104],
  [105, "MemoryUsageCounters", Migration0105],
  [106, "MemoryRevertResults", Migration0106],
  [107, "HandoffLookupIndex", Migration0107],
  [108, "MemoryLastReadySpace", Migration0108],
  [109, "MemoryHubAdministered", Migration0109],
  [110, "MemoryCheckpointLifecycle", Migration0110],
  [111, "FleetGoals", Migration0111],
  [112, "FleetHealth", Migration0112],
  [113, "ThreadRunObservedChecks", Migration0113],
  [114, "RemoteDispatchObservation", Migration0114],
  [115, "MemoryRevisionCheckpointSize", Migration0115],
  [116, "HubNodes", Migration0116],
  [117, "MemorySummaryWorkThreadIndex", Migration0117],
  [118, "ThreadHistoryArchives", Migration0118],
  [119, "PermissionProfiles", Migration0119],
  [120, "DecisionInbox", Migration0120],
  [121, "HumanStepRecords", Migration0121],
  [122, "McpRequestReservations", Migration0122],
  [123, "RemoteReportInboxRunId", Migration0123],
  [124, "RemoteReportReceipts", Migration0124],
  [125, "PendingAttachmentUploads", Migration0125],
  [126, "ScheduledTaskWebhookSecretRef", Migration0126],
  [127, "RemoteReportFences", Migration0127],
  [128, "HubProvisionedLinks", Migration0128],
  [129, "ScheduledTaskRuns", Migration0129],
  [130, "ScheduledTaskNotificationPolicy", Migration0130],
  [131, "NotificationCursorRepair", Migration0131],
  [132, "ConnectLinkTrust", Migration0132],
  [133, "McpEvalJournal", Migration0133],
  [134, "DecisionRoutes", Migration0134],
  [135, "HubConnectAccess", Migration0135],
  [136, "ChannelBotSessions", Migration0136],
  [137, "MemoryGenerationReportBacklog", Migration0137],
  [138, "ChannelSessionReceipts", Migration0138],
  [139, "BrowserSiteNotes", Migration0139],
  [140, "ComputerUseSessionApprovals", Migration0140],
  [141, "ComputerUseNamedApprovals", Migration0141],
  [142, "ComputerUseInputHistory", Migration0142],
  [143, "MemoryCheckpointBound", Migration0143],
  [144, "WorktreeSnapshots", Migration0144],
  [145, "ChannelBotIds", Migration0145],
  [146, "ScheduledBotRoutines", Migration0146],
  [147, "RemoteDispatchDeleteIntent", Migration0147],
  [148, "ChannelInterimMessages", Migration0148],
  [149, "ChannelNewestAsk", Migration0149],
  [150, "PlacementAdmission", Migration0150],
  [151, "AuthSessionPenBinding", Migration0151],
  [152, "ChannelOutboxOperations", Migration0152],
  [153, "RemoteDispatchHostOutage", Migration0153],
  [154, "ChannelBotTaskHistory", Migration0154],
  [155, "DisposableMachines", Migration0155],
  [156, "DisposableMachineRequests", Migration0156],
  [157, "DisposableMachineEnrollment", Migration0157],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const knownMigrationNames: ReadonlySet<string> = new Set(migrationEntries.map(([, name]) => name));

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

// Migrators skip ids up to the highest recorded; reject collisions that would skip V2 schema.
const assertV2MigrationsCanRun = Effect.fn("assertV2MigrationsCanRun")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const skipped = skippedV2Migrations(migrationEntries, recorded, latestRecordedId, throughId);
  if (skipped !== undefined) return yield* skipped;
});

const run = Migrator.make({});

const latestMigrationId = Math.max(...migrationEntries.map(([id]) => id));

// Mirrors runMigrations' writes: the Migrator runs only ids above the highest recorded, plus the
// V2-preview reconciliation and GOAT's id shift with the upstream migrations it displaced
// (reconcileGoatMigrationIds), which a restart resumes.
export const hasPendingMigrations = Effect.fn("hasPendingMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return true;
  const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
  `;
  const latestId = Math.max(0, ...history.map((row) => row.migration_id));
  const previewRows = history.some(
    (row) => row.name === "OrchestrationV2" && (row.migration_id === 53 || row.migration_id === 54),
  );
  return (
    latestId < latestMigrationId ||
    previewRows ||
    goatMigrationIdsMove(migrationEntries, history) ||
    displacedUpstreamMigrations(migrationEntries, history).length > 0
  );
});

const failIfDatabaseNewerThanBuild = Effect.fn("failIfDatabaseNewerThanBuild")(function* (
  error: Migrator.MigrationError,
) {
  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* Effect.catch(
    sql<{ readonly name: string }>`SELECT name FROM effect_sql_migrations`,
    () => Effect.fail(error),
  );
  const unknownMigrations: Array<string> = [];
  const seen = new Set<string>();
  for (const row of recorded) {
    if (knownMigrationNames.has(row.name) || seen.has(row.name)) continue;
    seen.add(row.name);
    unknownMigrations.push(row.name);
  }
  if (unknownMigrations.length === 0) return yield* error;
  return yield* new DatabaseNewerThanBuildError({
    unknownMigrations,
    originalMessage: error.message,
  });
});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const includesV2 =
    toMigrationInclusive === undefined || toMigrationInclusive >= FIRST_V2_MIGRATION_ID;
  const executedMigrations = yield* Effect.gen(function* () {
    yield* assertMemoryMigrationsCompatible(migrationEntries);
    const previewMigrations = includesV2 ? yield* reconcileV2PreviewMigration() : [];
    // GOAT ledgers move before the V2 check, which would otherwise read GOAT's
    // old ids as upstream migrations the migrator skips.
    const goatMigrations = yield* reconcileGoatMigrationIds(migrationEntries);
    if (includesV2) {
      yield* assertV2MigrationsCanRun(toMigrationInclusive);
    }
    const sql = yield* SqlClient.SqlClient;
    const ledger = yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    const [latest] =
      ledger.length === 0
        ? []
        : yield* sql<{
            readonly id: number | null;
          }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
    const latestRecordedId = latest?.id ?? 0;
    const pending = migrationEntries.filter(
      ([id]) =>
        id > latestRecordedId && (toMigrationInclusive === undefined || id <= toMigrationInclusive),
    );
    // One transaction per migration: an index build on a large database can take minutes, and a
    // restart then resumes after the last finished migration instead of rolling all of them back.
    const executed: Array<readonly [id: number, name: string]> = [
      ...previewMigrations,
      ...goatMigrations,
    ];
    for (const [index, [id, name]] of pending.entries()) {
      if (latestRecordedId > 0) {
        yield* Effect.log("Upgrading database").pipe(
          Effect.annotateLogs({
            migration: `${id}_${name}`,
            progress: `${index + 1} of ${pending.length}`,
          }),
        );
      }
      executed.push(...(yield* run({ loader: makeMigrationLoader(id) })));
    }
    return executed;
  }).pipe(Effect.catchTags({ MigrationError: failIfDatabaseNewerThanBuild }));
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  return executedMigrations;
});
