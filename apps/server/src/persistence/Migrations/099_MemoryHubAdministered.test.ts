import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./099_MemoryHubAdministered.ts";

it.effect.each(["empty", "admin", "guard", "member", "last-ready"] as const)(
  "082 backfills durable administration from %s",
  (source) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Only the columns read by this migration: each historical source stands alone.
      yield* sql`CREATE TABLE memory_outbox(kind TEXT)`;
      yield* sql`CREATE TABLE memory_import_keys(key_kind TEXT)`;
      yield* sql`CREATE TABLE memory_hub_members(environment TEXT)`;
      yield* sql`CREATE TABLE memory_last_ready_space(space TEXT)`;
      if (source === "admin") yield* sql`INSERT INTO memory_outbox VALUES('admin')`;
      if (source === "guard") yield* sql`INSERT INTO memory_import_keys VALUES('hub_admin')`;
      if (source === "member") yield* sql`INSERT INTO memory_hub_members VALUES('fixture')`;
      if (source === "last-ready")
        yield* sql`INSERT INTO memory_last_ready_space VALUES('fixture')`;
      yield* migration;
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_hub_administration_state`,
        source === "empty" ? [] : [{ singleton: 1, administered: 1 }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
it.effect("082 participates in the migration ledger and preserves its flag on rerun", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 98 });
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 121 }), [
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
    yield* sql`INSERT INTO memory_hub_administration_state VALUES(1,1)`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 121 }), []);
    assert.deepStrictEqual(yield* sql`SELECT administered FROM memory_hub_administration_state`, [
      { administered: 1 },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
