import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./097_MemoryLastReadySpace.ts";

it.effect("081 rolls DDL back and preserves the retained destination across ledger reruns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 96 });
    const space = "00000000-0000-4000-8000-000000000001";
    yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},'fixture',0,'ready')`;
    const rollback = yield* sql
      .withTransaction(migration.pipe(Effect.andThen(Effect.fail("rollback"))))
      .pipe(Effect.exit);
    assert.deepStrictEqual(rollback, Exit.fail("rollback"));
    assert.isEmpty(yield* sql`SELECT name FROM sqlite_master WHERE name='memory_last_ready_space'`);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 120 }), [
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
    ]);
    yield* sql`INSERT INTO memory_last_ready_space(singleton,space) VALUES (1,${space})`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 120 }), []);
    assert.deepStrictEqual(yield* sql`SELECT singleton,space FROM memory_last_ready_space`, [
      { singleton: 1, space },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT bootstrap_state FROM memory_sync_cursors`, [
      { bootstrap_state: "ready" },
    ]);
    assert.isTrue(
      Exit.isFailure(
        yield* sql`INSERT INTO memory_last_ready_space(singleton,space) VALUES (2,${space})`.pipe(
          Effect.exit,
        ),
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
