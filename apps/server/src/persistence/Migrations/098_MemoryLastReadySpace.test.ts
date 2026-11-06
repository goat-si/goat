import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./098_MemoryLastReadySpace.ts";

it.effect("081 rolls DDL back and preserves the retained destination across ledger reruns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 97 });
    const space = "00000000-0000-4000-8000-000000000001";
    yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},'fixture',0,'ready')`;
    const rollback = yield* sql
      .withTransaction(migration.pipe(Effect.andThen(Effect.fail("rollback"))))
      .pipe(Effect.exit);
    assert.deepStrictEqual(rollback, Exit.fail("rollback"));
    assert.isEmpty(yield* sql`SELECT name FROM sqlite_master WHERE name='memory_last_ready_space'`);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 121 }), [
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
    yield* sql`INSERT INTO memory_last_ready_space(singleton,space) VALUES (1,${space})`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 121 }), []);
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
