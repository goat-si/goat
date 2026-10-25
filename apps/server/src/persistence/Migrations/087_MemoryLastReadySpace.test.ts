import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./087_MemoryLastReadySpace.ts";

it.effect("081 rolls DDL back and preserves the retained destination across ledger reruns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 86 });
    const space = "00000000-0000-4000-8000-000000000001";
    yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},'fixture',0,'ready')`;
    const rollback = yield* sql
      .withTransaction(migration.pipe(Effect.andThen(Effect.fail("rollback"))))
      .pipe(Effect.exit);
    assert.deepStrictEqual(rollback, Exit.fail("rollback"));
    assert.isEmpty(yield* sql`SELECT name FROM sqlite_master WHERE name='memory_last_ready_space'`);
    assert.deepStrictEqual(yield* runMigrations(), [
      [87, "MemoryLastReadySpace"],
      [88, "MemoryHubAdministered"],
      [89, "MemoryCheckpointLifecycle"],
      [90, "FleetGoals"],
      [91, "FleetHealth"],
      [92, "ThreadRunObservedChecks"],
      [93, "RemoteDispatchObservation"],
      [94, "MemoryRevisionCheckpointSize"],
      [95, "HubNodes"],
      [96, "MemorySummaryWorkThreadIndex"],
      [97, "ThreadHistoryArchives"],
      [98, "PermissionProfiles"],
      [99, "DecisionInbox"],
      [100, "HumanStepRecords"],
      [101, "McpRequestReservations"],
      [102, "RemoteReportInboxRunId"],
      [103, "RemoteReportReceipts"],
      [104, "PendingAttachmentUploads"],
      [105, "ScheduledTaskWebhookSecretRef"],
      [106, "RemoteReportFences"],
      [107, "HubProvisionedLinks"],
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
