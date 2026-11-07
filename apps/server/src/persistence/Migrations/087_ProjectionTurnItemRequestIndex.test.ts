import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import ProjectionTurnItemRequestIndex from "./087_ProjectionTurnItemRequestIndex.ts";

it.effect(
  "indexes existing request bodies on upgrade from 69 and can run again after relocation",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 86 });
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

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 121 }), [
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
      yield* ProjectionTurnItemRequestIndex;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 121 }), []);

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
