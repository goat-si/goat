import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./089_MemoryHubAdministered.ts";

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
    yield* runMigrations({ toMigrationInclusive: 88 });
    assert.deepStrictEqual(yield* runMigrations(), [
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
    yield* sql`INSERT INTO memory_hub_administration_state VALUES(1,1)`;
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* sql`SELECT administered FROM memory_hub_administration_state`, [
      { administered: 1 },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
