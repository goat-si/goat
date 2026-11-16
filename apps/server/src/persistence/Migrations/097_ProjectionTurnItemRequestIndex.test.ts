import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import ProjectionTurnItemRequestIndex from "./097_ProjectionTurnItemRequestIndex.ts";

it.effect(
  "indexes existing request bodies on upgrade from 69 and can run again after relocation",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 96 });
      yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES
        ('question', 'thread', 1, 'user_input_request', 'waiting', '2026-10-14', '{"requestId":"007"}'),
        ('approval', 'thread', 2, 'approval_request', 'waiting', '2026-10-14', '{"requestId":"approval"}'),
        ('other-thread', 'other', 1, 'user_input_request', 'waiting', '2026-10-14', '{"requestId":"007"}'),
        ('other-type', 'thread', 3, 'command_execution', 'completed', '2026-10-14', '{"requestId":"007"}'),
        ('unrelated-payload', 'thread', 4, 'command_execution', 'completed', '2026-10-14', 'not JSON')
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES
        ('007', 'thread', 'node', 'user_input', 'pending', '2026-10-14', '{}'),
        ('approval', 'thread', 'node', 'command', 'pending', '2026-10-14', '{}')
    `;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 131 }), [
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
      yield* ProjectionTurnItemRequestIndex;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 131 }), []);

      const indexes = yield* sql<{ readonly name: string; readonly partial: number }>`
      PRAGMA index_list(orchestration_v2_projection_turn_items)
    `;
      assert.lengthOf(
        indexes.filter(
          (index) =>
            index.name === "orchestration_v2_projection_turn_items_thread_request_idx" &&
            index.partial === 1,
        ),
        1,
      );
      const matches = yield* sql<{ readonly turn_item_id: string }>`
      SELECT request_item.turn_item_id
      FROM orchestration_v2_projection_runtime_requests AS pending_request
        INDEXED BY orchestration_v2_projection_runtime_requests_thread_status_idx
      CROSS JOIN orchestration_v2_projection_turn_items AS request_item
        INDEXED BY orchestration_v2_projection_turn_items_thread_request_idx
        ON request_item.thread_id = pending_request.thread_id
          AND request_item.type IN ('user_input_request', 'approval_request')
          AND json_extract(request_item.payload_json, '$.requestId') = +pending_request.runtime_request_id
      WHERE pending_request.thread_id = 'thread' AND pending_request.status = 'pending'
      ORDER BY request_item.ordinal
    `;
      assert.deepStrictEqual(matches, [{ turn_item_id: "question" }, { turn_item_id: "approval" }]);
      const preserved = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items
    `;
      assert.strictEqual(preserved[0]!.count, 5);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
