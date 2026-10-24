import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./088_MemoryHubAdministered.ts";

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
    yield* runMigrations({ toMigrationInclusive: 87 });
    assert.deepStrictEqual(yield* runMigrations(), [
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
    ]);
    yield* sql`INSERT INTO memory_hub_administration_state VALUES(1,1)`;
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* sql`SELECT administered FROM memory_hub_administration_state`, [
      { administered: 1 },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
