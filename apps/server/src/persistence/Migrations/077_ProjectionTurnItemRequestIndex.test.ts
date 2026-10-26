import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import ProjectionTurnItemRequestIndex from "./077_ProjectionTurnItemRequestIndex.ts";

it.effect(
  "indexes existing request bodies on upgrade from 69 and can run again after relocation",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
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

      assert.deepStrictEqual(yield* runMigrations(), [
        [77, "ProjectionTurnItemRequestIndex"],
        [78, "Memory"],
        [79, "MemoryHubSync"],
        [80, "MemorySearchCounters"],
        [81, "MemoryTaskGrantCeiling"],
        [82, "MemoryImportLineage"],
        [83, "MemoryCheckpointAccounting"],
        [84, "MemoryReportLifecycle"],
        [85, "MemoryUsageCounters"],
        [86, "MemoryRevertResults"],
        [87, "HandoffLookupIndex"],
        [88, "MemoryLastReadySpace"],
        [89, "MemoryHubAdministered"],
        [90, "MemoryCheckpointLifecycle"],
        [91, "FleetGoals"],
        [92, "FleetHealth"],
        [93, "ThreadRunObservedChecks"],
        [94, "RemoteDispatchObservation"],
        [95, "MemoryRevisionCheckpointSize"],
        [96, "HubNodes"],
        [97, "MemorySummaryWorkThreadIndex"],
        [98, "ThreadHistoryArchives"],
        [99, "PermissionProfiles"],
        [100, "DecisionInbox"],
        [101, "HumanStepRecords"],
        [102, "McpRequestReservations"],
        [103, "RemoteReportInboxRunId"],
        [104, "RemoteReportReceipts"],
        [105, "PendingAttachmentUploads"],
        [106, "ScheduledTaskWebhookSecretRef"],
        [107, "RemoteReportFences"],
        [108, "HubProvisionedLinks"],
      ]);
      yield* ProjectionTurnItemRequestIndex;
      assert.deepStrictEqual(yield* runMigrations(), []);

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
