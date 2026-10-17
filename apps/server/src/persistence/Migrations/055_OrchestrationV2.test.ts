import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_OrchestrationV2", (it) => {
  it.effect("keeps released migrations contiguous", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationEntries.map(([id]) => id),
        Array.from({ length: 83 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("upgrades released schema 53 through the latest migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "ServerActivityIndexes"],
        [64, "RemoteReports"],
        [65, "RemoteDispatches"],
        [66, "ChannelLedger"],
        [67, "RemoteDispatchQuestions"],
        [68, "ThreadRunResults"],
        [69, "RemoteReportRelay"],
        [70, "ProjectionTurnItemRequestIndex"],
        [71, "Memory"],
        [72, "MemoryHubSync"],
        [73, "MemorySearchCounters"],
        [74, "MemoryTaskGrantCeiling"],
        [75, "MemoryImportLineage"],
        [76, "MemoryCheckpointAccounting"],
        [77, "MemoryReportLifecycle"],
        [78, "MemoryUsageCounters"],
        [79, "MemoryRevertResults"],
        [80, "HandoffLookupIndex"],
        [81, "MemoryLastReadySpace"],
        [82, "MemoryHubAdministered"],
        [83, "MemoryCheckpointLifecycle"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 48
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        { migration_id: 48, name: "ProjectionThreadBranchPullRequest" },
        { migration_id: 49, name: "ProjectionThreadsActiveOrderKey" },
        { migration_id: 50, name: "ProjectionThreadPullRequests" },
        { migration_id: 51, name: "ProjectionThreadMessageContext" },
        { migration_id: 52, name: "ProjectionThreadTitleState" },
        { migration_id: 53, name: "PullRequestFilesViewed" },
        { migration_id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
        { migration_id: 55, name: "OrchestrationV2" },
        { migration_id: 56, name: "RemoveRedundantProjectionIndexes" },
        { migration_id: 57, name: "ScheduledTaskWebhooks" },
        { migration_id: 58, name: "WebhookRelayDeliveries" },
        { migration_id: 59, name: "McpAppModelContext" },
        { migration_id: 60, name: "ThreadSnapshotWindowIndexes" },
        { migration_id: 61, name: "PullRequestReviewGuides" },
        { migration_id: 62, name: "ThreadFailureLookupIndex" },
        { migration_id: 63, name: "ServerActivityIndexes" },
        { migration_id: 64, name: "RemoteReports" },
        { migration_id: 65, name: "RemoteDispatches" },
        { migration_id: 66, name: "ChannelLedger" },
        { migration_id: 67, name: "RemoteDispatchQuestions" },
        { migration_id: 68, name: "ThreadRunResults" },
        { migration_id: 69, name: "RemoteReportRelay" },
        { migration_id: 70, name: "ProjectionTurnItemRequestIndex" },
        { migration_id: 71, name: "Memory" },
        { migration_id: 72, name: "MemoryHubSync" },
        { migration_id: 73, name: "MemorySearchCounters" },
        { migration_id: 74, name: "MemoryTaskGrantCeiling" },
        { migration_id: 75, name: "MemoryImportLineage" },
        { migration_id: 76, name: "MemoryCheckpointAccounting" },
        { migration_id: 77, name: "MemoryReportLifecycle" },
        { migration_id: 78, name: "MemoryUsageCounters" },
        { migration_id: 79, name: "MemoryRevertResults" },
        { migration_id: 80, name: "HandoffLookupIndex" },
        { migration_id: 81, name: "MemoryLastReadySpace" },
        { migration_id: 82, name: "MemoryHubAdministered" },
        { migration_id: 83, name: "MemoryCheckpointLifecycle" },
      ]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'orchestration_v2_projection_threads',
            'orchestration_v2_projection_subagents',
            'orchestration_v2_effect_outbox',
            'orchestration_v2_turn_item_positions',
            'orchestration_v2_projection_metadata',
            'orchestration_v2_projection_provider_session_bindings',
            'orchestration_v2_thread_launch_workflows',
            'orchestration_v2_legacy_imports',
            'scheduled_tasks'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        [
          "orchestration_v2_effect_outbox",
          "orchestration_v2_legacy_imports",
          "orchestration_v2_projection_metadata",
          "orchestration_v2_projection_provider_session_bindings",
          "orchestration_v2_projection_subagents",
          "orchestration_v2_projection_threads",
          "orchestration_v2_thread_launch_workflows",
          "orchestration_v2_turn_item_positions",
          "scheduled_tasks",
        ],
      );

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_events)
      `;
      const receiptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_command_receipts)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_threads)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;
      assert.ok(eventColumns.some(({ name }) => name === "application_event_version"));
      assert.ok(receiptColumns.some(({ name }) => name === "command_type"));
      assert.ok(threadColumns.some(({ name }) => name === "provider_instance_id"));
      assert.ok(subagentColumns.some(({ name }) => name === "driver"));
      assert.ok(subagentColumns.some(({ name }) => name === "provider_instance_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_orchestration_events_application_high_water',
            'orchestration_events_v2_created_threads_idx',
            'orchestration_v2_projection_turn_items_shell_pending_idx'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map(({ name }) => name),
        [
          "idx_orchestration_events_application_high_water",
          "orchestration_events_v2_created_threads_idx",
          "orchestration_v2_projection_turn_items_shell_pending_idx",
        ],
      );
    }),
  );
});
