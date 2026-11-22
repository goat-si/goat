import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import type * as SqlClient from "effect/sql/SqlClient";

// Frozen against the predecessor squash commits so current compatibility changes cannot affect this check.
// 3b230eec63f06819394fee12956c7d5ef1fee351
// 3afb4afcc06deb0e7702ac843187f6e6cafec975
const FIRST_V2_MIGRATION_ID = 55;
const WORK_TRIGGER_FENCE_MIGRATION_NAME = "WorkTriggerAuthorityFence";
const CHANNEL_LEDGER_MIGRATION = "ChannelLedger";
const WORK_TRIGGER_LEDGER_FENCE = "ChannelLedgerRequiresWorkTriggerAuthority";
const canonicalMigrationName = (name: string) =>
  name === WORK_TRIGGER_LEDGER_FENCE ? CHANNEL_LEDGER_MIGRATION : name;

type MigrationEntry = readonly [id: number, name: string];

const manifest3795 = [
  [55, "OrchestrationV2"],
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
  [158, "AuthSessionPenMember"],
  [159, "MemoryThreadLineage"],
  [160, "MemorySaveSuggestions"],
  [161, "MemoryHubFloor"],
  [162, "MemoryScopeVersion"],
  [163, "MemoryCompactMoveReceipts"],
  [164, "MemoryOriginCatchup"],
  [165, "MemorySuggestionQuota"],
  [166, "ScheduledTaskFirstBindIntent"],
  [167, "QueuedTurnInputIndexJsonValid"],
  [168, "TurnItemMessageOrdinalIndex"],
  [169, "TurnItemInlineWorkOutput"],
  [170, "RepairStaleTitleRegeneration"],
  [175, "AcpSessionOwnerIndex"],
  [176, "ChannelWorkerLaunchHeads"],
] as const satisfies ReadonlyArray<MigrationEntry>;

const manifest3797 = [...manifest3795, [177, WORK_TRIGGER_FENCE_MIGRATION_NAME]] as const;

const skippedV2Migrations3795 = (
  entries: ReadonlyArray<MigrationEntry>,
  history: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
  upTo: number,
  throughId?: number,
  highestRecorded = upTo,
) => {
  const recordedNames = new Map(history.map((row) => [row.migration_id, row.name]));
  const skipped = entries.flatMap(([id, name]) => {
    if (id < FIRST_V2_MIGRATION_ID || id > upTo || (throughId !== undefined && id > throughId))
      return [];
    const recordedName = recordedNames.get(id);
    return recordedName === name ? [] : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  return skipped.length === 0
    ? undefined
    : new Migrator.MigrationError({
        kind: "BadState",
        message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${highestRecorded}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
      });
};

const skippedV2Migrations3797 = (
  entries: ReadonlyArray<MigrationEntry>,
  history: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
  upTo: number,
  throughId?: number,
  highestRecorded = upTo,
) => {
  const supportsWorkTriggers = entries.some(
    ([, name]) => name === WORK_TRIGGER_FENCE_MIGRATION_NAME,
  );
  const recordedNames = new Map(
    history.map((row) => [
      row.migration_id,
      supportsWorkTriggers ? canonicalMigrationName(row.name) : row.name,
    ]),
  );
  const skipped = entries.flatMap(([id, name]) => {
    if (id < FIRST_V2_MIGRATION_ID || id > upTo || (throughId !== undefined && id > throughId))
      return [];
    const recordedName = recordedNames.get(id);
    return recordedName === name ? [] : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  return skipped.length === 0
    ? undefined
    : new Migrator.MigrationError({
        kind: "BadState",
        message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${highestRecorded}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
      });
};

export const checkRollbackPredecessor = Effect.fn("checkRollbackPredecessor")(function* (
  sql: SqlClient.SqlClient,
  through: 176 | 177,
) {
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  return through === 176
    ? skippedV2Migrations3795(manifest3795, recorded, latestRecordedId)
    : skippedV2Migrations3797(manifest3797, recorded, latestRecordedId);
});
