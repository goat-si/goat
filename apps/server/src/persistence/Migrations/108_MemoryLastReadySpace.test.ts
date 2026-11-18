import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./108_MemoryLastReadySpace.ts";

it.effect("081 rolls DDL back and preserves the retained destination across ledger reruns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 107 });
    const space = "00000000-0000-4000-8000-000000000001";
    yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},'fixture',0,'ready')`;
    const rollback = yield* sql
      .withTransaction(migration.pipe(Effect.andThen(Effect.fail("rollback"))))
      .pipe(Effect.exit);
    assert.deepStrictEqual(rollback, Exit.fail("rollback"));
    assert.isEmpty(yield* sql`SELECT name FROM sqlite_master WHERE name='memory_last_ready_space'`);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 131 }), [
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
    yield* sql`INSERT INTO memory_last_ready_space(singleton,space) VALUES (1,${space})`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 131 }), []);
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
