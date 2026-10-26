import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./088_MemoryLastReadySpace.ts";

it.effect("081 rolls DDL back and preserves the retained destination across ledger reruns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 87 });
    const space = "00000000-0000-4000-8000-000000000001";
    yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},'fixture',0,'ready')`;
    const rollback = yield* sql
      .withTransaction(migration.pipe(Effect.andThen(Effect.fail("rollback"))))
      .pipe(Effect.exit);
    assert.deepStrictEqual(rollback, Exit.fail("rollback"));
    assert.isEmpty(yield* sql`SELECT name FROM sqlite_master WHERE name='memory_last_ready_space'`);
    assert.deepStrictEqual(yield* runMigrations(), [
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
    yield* sql`INSERT INTO memory_last_ready_space(singleton,space) VALUES (1,${space})`;
    assert.deepStrictEqual(yield* runMigrations(), []);
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
